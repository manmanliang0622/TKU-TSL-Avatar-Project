const recognizeBtn = document.getElementById("recognizeBtn");
const generateBtn = document.getElementById("generateBtn");
const recognitionStatus = document.getElementById("recognitionStatus");
const progressBar = document.getElementById("progressBar");
const recognizedText = document.getElementById("recognizedText");
const inputText = document.getElementById("inputText");
const llmResult = document.getElementById("llmResult");
const avatarStatus = document.getElementById("avatarStatus");
const presetButtons = document.querySelectorAll(".preset");

const canvas = document.getElementById("avatarCanvas");
const ctx = canvas.getContext("2d");

const recognitionExamples = [
  "辨識結果：您好，很高興為您服務。",
  "辨識結果：今天下午三點開會，請準時到場。",
  "辨識結果：請問洗手間在哪裡？謝謝。",
];

const poses = {
  idle: { left: -0.55, right: 0.55, ly: 0.04, ry: 0.04 },
  greet: { left: -1.0, right: 1.08, ly: -0.18, ry: -0.26 },
  inform: { left: -0.35, right: 0.88, ly: 0.08, ry: -0.08 },
  question: { left: -0.82, right: 0.18, ly: -0.06, ry: -0.16 },
};

let recognitionIndex = 0;
let animationFrame = null;
let animationStart = 0;
let activeSequence = ["idle", "idle"];

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    inputText.value = button.dataset.text;
    updateLLMResult();
  });
});

recognizeBtn.addEventListener("click", () => {
  recognizeBtn.disabled = true;
  recognizeBtn.textContent = "辨識中...";
  recognitionStatus.textContent = "正在擷取虛擬人物動作";
  progressBar.style.width = "25%";
  recognizedText.value = "系統正在透過骨架特徵與 LLM 模型進行語意翻譯，請稍候...";

  setTimeout(() => {
    recognitionStatus.textContent = "正在分析手語語意";
    progressBar.style.width = "60%";
  }, 800);

  setTimeout(() => {
    recognitionStatus.textContent = "正在生成辨識文字";
    progressBar.style.width = "88%";
  }, 1600);

  setTimeout(() => {
    recognizedText.value =
      recognitionExamples[recognitionIndex % recognitionExamples.length];
    recognitionIndex += 1;
    recognitionStatus.textContent = "辨識完成";
    progressBar.style.width = "100%";
    recognizeBtn.disabled = false;
    recognizeBtn.textContent = "再次辨識";
  }, 2400);
});

generateBtn.addEventListener("click", () => {
  updateLLMResult();
  const text = inputText.value.trim();
  activeSequence = getSequence(text);

  generateBtn.disabled = true;
  generateBtn.textContent = "播放中...";
  avatarStatus.textContent = "LLM 已完成翻譯，虛擬人物生成手語中";
  startAnimation();

  setTimeout(() => {
    generateBtn.disabled = false;
    generateBtn.textContent = "播放手語";
    avatarStatus.textContent = "播放完成，可再次生成";
  }, 5000);
});

inputText.addEventListener("input", updateLLMResult);

function updateLLMResult() {
  const text = inputText.value.trim() || "請輸入要翻譯成手語的句子";
  const intent = getIntent(text);

  llmResult.textContent = JSON.stringify(
    {
      input_text: text,
      llm_translation_mode: "taiwan-sign-language",
      intent,
      translation_result: "已將句子轉為虛擬人物可播放的手語動作序列",
      avatar_animation_sequence: getSequence(text),
      output_type: "virtual-human-sign-animation",
    },
    null,
    2
  );
}

function getIntent(text) {
  if (text.includes("您好") || text.includes("歡迎")) return "greeting";
  if (text.includes("請問") || text.includes("哪裡")) return "question";
  return "statement";
}

function getSequence(text) {
  const intent = getIntent(text);
  if (intent === "greeting") return ["idle", "greet", "inform", "greet", "idle"];
  if (intent === "question") return ["idle", "question", "inform", "question", "idle"];
  return ["idle", "inform", "inform", "greet", "idle"];
}

function startAnimation() {
  cancelAnimationFrame(animationFrame);
  animationStart = performance.now();

  const duration = 4200;

  const animate = (time) => {
    const progress = Math.min((time - animationStart) / duration, 1);
    drawAvatar(progress);
    if (progress < 1) {
      animationFrame = requestAnimationFrame(animate);
    }
  };

  animationFrame = requestAnimationFrame(animate);
}

function drawAvatar(progress) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const centerX = canvas.width / 2;
  const headY = 110;
  const shoulderY = 180;
  const hipY = 300;
  const pose = interpolatePose(progress);

  drawBackground(centerX);

  ctx.fillStyle = "#ffd8b0";
  ctx.beginPath();
  ctx.arc(centerX, headY, 40, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#20344b";
  ctx.beginPath();
  ctx.arc(centerX, headY - 8, 42, Math.PI, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#2b3f54";
  ctx.lineWidth = 18;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(centerX, shoulderY);
  ctx.lineTo(centerX, hipY);
  ctx.stroke();

  ctx.fillStyle = "#2f6f68";
  ctx.fillRect(centerX - 65, shoulderY + 8, 130, 110);

  drawArm(centerX - 12, shoulderY, Math.PI * 0.95, pose.left, pose.ly);
  drawArm(centerX + 12, shoulderY, Math.PI * 0.05, pose.right, pose.ry);
}

function drawBackground(centerX) {
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(15,118,110,0.08)";
  ctx.beginPath();
  ctx.arc(centerX, 120, 120, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(234,88,12,0.08)";
  ctx.beginPath();
  ctx.arc(centerX - 110, 410, 150, 0, Math.PI * 2);
  ctx.fill();
}

function drawArm(startX, startY, shoulderAngle, elbowAngle, offsetY) {
  const upperLen = 84;
  const lowerLen = 76;

  const elbowX = startX + Math.cos(shoulderAngle) * upperLen;
  const elbowY = startY + Math.sin(shoulderAngle) * upperLen;

  const wristAngle = shoulderAngle + elbowAngle;
  const wristX = elbowX + Math.cos(wristAngle) * lowerLen;
  const wristY = elbowY + Math.sin(wristAngle + offsetY) * lowerLen;

  ctx.strokeStyle = "#ffd8b0";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(wristX, wristY);
  ctx.stroke();

  ctx.fillStyle = "#ffd8b0";
  ctx.beginPath();
  ctx.arc(wristX, wristY, 10, 0, Math.PI * 2);
  ctx.fill();
}

function interpolatePose(progress) {
  const maxIndex = activeSequence.length - 1;
  const scaled = progress * maxIndex;
  const index = Math.min(Math.floor(scaled), maxIndex - 1);
  const local = scaled - index;

  const from = poses[activeSequence[index]];
  const to = poses[activeSequence[index + 1]] || from;
  const eased = ease(local);

  return {
    left: lerp(from.left, to.left, eased),
    right: lerp(from.right, to.right, eased),
    ly: lerp(from.ly, to.ly, eased),
    ry: lerp(from.ry, to.ry, eased),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

updateLLMResult();
drawAvatar(0);
