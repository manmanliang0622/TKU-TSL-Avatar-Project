from pathlib import Path
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


SOURCE_ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# start/stop_0813.sh 是給學校的 Linux 主機用的：靠 flock 排隊、ss 查 port、
# /proc/<pid>/cmdline 確認行程是自己的，測試也照 Linux 的 errno 111 判斷連線被拒。
# macOS 沒有 flock、沒有 /proc，在那裡跑只會得到 command not found。
LINUX_HOST = (
    sys.platform.startswith("linux")
    and Path("/proc/self/cmdline").exists()
    and all(shutil.which(tool) for tool in ("flock", "ss", "curl"))
)


@unittest.skipUnless(LINUX_HOST, "需要 Linux 的 flock、ss 與 /proc（學校主機上跑）")
class LifecycleBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="0813-lifecycle-")
        self.root = Path(self.temp.name)
        (self.root / "logs").mkdir()
        (self.root / ".venv/bin").mkdir(parents=True)
        (self.root / "model_service/base_model").mkdir(parents=True)
        (self.root / "model_service/checkpoint").mkdir(parents=True)
        (self.root / "model_service/scripts").mkdir(parents=True)
        os.symlink("/usr/bin/python3", self.root / ".venv/bin/python3")
        for source in ["start_0813.sh", "stop_0813.sh", "health_0813.sh"]:
            shutil.copy2(SOURCE_ROOT / source, self.root / source)
            (self.root / source).chmod(0o755)
        for artifact in [
            "model_service/base_model/config.json",
            "model_service/base_model/model.safetensors",
            "model_service/checkpoint/adapter_config.json",
            "model_service/checkpoint/adapter_model.safetensors",
        ]:
            (self.root / artifact).write_text("fake", encoding="utf-8")
        self.fake_model = self.root / "model_service/scripts/serve_model.py"
        self.fake_model.write_text(
            "import signal,time\nsignal.signal(signal.SIGTERM, lambda *_: exit(0))\n"
            "while True: time.sleep(1)\n",
            encoding="utf-8",
        )
        self.bundle = self.root / "bundle_server.py"
        self.bundle.write_text(
            textwrap.dedent(
                """
                import argparse,json,signal,subprocess,sys
                from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
                from pathlib import Path

                ROOT=Path(__file__).resolve().parent
                parser=argparse.ArgumentParser()
                parser.add_argument('--host'); parser.add_argument('--port',type=int)
                parser.add_argument('--model-port',type=int)
                args=parser.parse_args()
                model=subprocess.Popen([sys.executable,str(ROOT/'model_service/scripts/serve_model.py')])
                (ROOT/'logs/v11-model.pid').write_text(str(model.pid)+'\\n')
                class Handler(BaseHTTPRequestHandler):
                    def log_message(self,*_args): pass
                    def do_GET(self):
                        body=json.dumps({'status':'ok','model':'qlora_e4b_v11_holdout',
                          'model_process_alive':model.poll() is None}).encode()
                        status=200 if model.poll() is None else 503
                        self.send_response(status); self.send_header('Content-Length',str(len(body)))
                        self.end_headers(); self.wfile.write(body)
                server=ThreadingHTTPServer((args.host,args.port),Handler)
                def stop(*_args):
                    model.terminate(); model.wait(timeout=5); raise KeyboardInterrupt
                signal.signal(signal.SIGTERM,stop)
                try: server.serve_forever()
                except KeyboardInterrupt: pass
                finally:
                    server.server_close()
                    if model.poll() is None: model.terminate(); model.wait(timeout=5)
                """
            ),
            encoding="utf-8",
        )
        self.port = free_port()
        self.model_port = free_port()
        self.environment = os.environ.copy()
        self.environment.update(
            PORT=str(self.port), MODEL_PORT=str(self.model_port), START_TIMEOUT="20"
        )

    def tearDown(self):
        subprocess.run(
            [str(self.root / "stop_0813.sh")],
            cwd=self.root,
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        self.temp.cleanup()

    def test_parallel_start_is_singleton_and_stop_releases_port(self):
        starts = [
            subprocess.Popen(
                [str(self.root / "start_0813.sh")],
                cwd=self.root,
                env=self.environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(3)
        ]
        results = [process.communicate(timeout=30) for process in starts]
        self.assertEqual([process.returncode for process in starts], [0, 0, 0], results)
        bundle_pid = int((self.root / "logs/bundle-server.pid").read_text())
        model_pid = int((self.root / "logs/v11-model.pid").read_text())
        self.assertTrue(Path(f"/proc/{bundle_pid}").exists())
        self.assertTrue(Path(f"/proc/{model_pid}").exists())
        stop = subprocess.run(
            [str(self.root / "stop_0813.sh")],
            cwd=self.root,
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(stop.returncode, 0, stop.stderr)
        self.assertFalse(Path(f"/proc/{bundle_pid}").exists())
        self.assertFalse(Path(f"/proc/{model_pid}").exists())
        with socket.socket() as sock:
            self.assertEqual(sock.connect_ex(("127.0.0.1", self.port)), 111)

    def test_stop_refuses_foreign_pid(self):
        foreign = subprocess.Popen(["sleep", "30"])
        try:
            (self.root / "logs/bundle-server.pid").write_text(str(foreign.pid))
            result = subprocess.run(
                [str(self.root / "stop_0813.sh")],
                cwd=self.root,
                env=self.environment,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIsNone(foreign.poll())
            self.assertIn("Refusing to stop", result.stderr)
        finally:
            foreign.terminate()
            foreign.wait(timeout=5)
            (self.root / "logs/bundle-server.pid").unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
