/* 온라인 입장 화면: POST /join {inviteCode, nickname}. 성공하면 서버가 세션 쿠키를 주고 로비(/)로 간다.
 * 이미 입장한 브라우저면 현재 닉네임을 채워 두고, 다시 입장하면 같은 사용자로 닉네임만 바뀐다. */
const form = document.getElementById("join-form");
const errorLine = form.querySelector(".setup-error");
const current = form.querySelector(".join-current");
const submit = form.querySelector(".setup-start");

fetch("/api/me")
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me) return;
    form.elements.nickname.value = me.nickname;
    current.textContent = `이미 "${me.nickname}"(으)로 입장해 있습니다. 다시 입장하면 닉네임만 바뀝니다.`;
    current.classList.remove("hidden");
  })
  .catch(() => {});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorLine.classList.add("hidden");
  submit.disabled = true;
  try {
    const res = await fetch("/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode: form.elements.inviteCode.value, nickname: form.elements.nickname.value }),
    });
    if (res.ok) {
      location.href = "/";
      return;
    }
    errorLine.textContent = (await res.text()) || "입장하지 못했습니다";
  } catch {
    errorLine.textContent = "서버에 연결하지 못했습니다";
  }
  errorLine.classList.remove("hidden");
  submit.disabled = false;
});
