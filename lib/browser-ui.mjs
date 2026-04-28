// @ts-check

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderBrowserPage({ authenticated, browserPath, agentName }) {
  const title = `${agentName || "HouseCarl"} Voice`;
  // Escape sequences that could break out of a <script> tag or trigger
  // HTML parsing artefacts when embedded in inline JSON.
  const config = JSON.stringify({
    authenticated,
    browserPath,
    agentName: agentName || "HouseCarl",
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: radial-gradient(circle at top, #20354a 0%, #0d1721 48%, #070b10 100%);
        --panel: rgba(9, 17, 26, 0.82);
        --panel-border: rgba(145, 197, 255, 0.18);
        --text: #e9f2fb;
        --muted: #9fb2c4;
        --accent: #8fd3ff;
        --accent-strong: #52b5ff;
        --danger: #ff7f7f;
        --ok: #8cf0bf;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }
      .shell {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(18px);
      }
      .hero {
        padding: 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        background: linear-gradient(135deg, rgba(143, 211, 255, 0.14), rgba(82, 181, 255, 0.03));
      }
      h1 {
        margin: 0;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1;
        letter-spacing: -0.04em;
      }
      .sub {
        margin: 10px 0 0;
        color: var(--muted);
        font-size: 15px;
      }
      .content {
        padding: 20px;
        display: grid;
        gap: 16px;
      }
      .card {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.03);
        padding: 16px;
      }
      .hidden { display: none !important; }
      form { display: grid; gap: 12px; }
      label {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      input, textarea, button {
        font: inherit;
      }
      input, textarea {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        background: rgba(6, 12, 19, 0.92);
        color: var(--text);
        padding: 14px 16px;
      }
      textarea {
        min-height: 110px;
        resize: vertical;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        cursor: pointer;
        color: #03131f;
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        font-weight: 700;
      }
      button.secondary {
        color: var(--text);
        background: rgba(255, 255, 255, 0.08);
      }
      button:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .status {
        min-height: 20px;
        color: var(--muted);
        font-size: 14px;
      }
      .status.error { color: var(--danger); }
      .status.ok { color: var(--ok); }
      .transcript {
        display: grid;
        gap: 10px;
        max-height: 48vh;
        overflow: auto;
      }
      .bubble {
        padding: 14px 16px;
        border-radius: 16px;
        white-space: pre-wrap;
        line-height: 1.45;
      }
      .bubble.user {
        background: rgba(82, 181, 255, 0.16);
        border: 1px solid rgba(82, 181, 255, 0.25);
      }
      .bubble.assistant {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.09);
      }
      .meta {
        color: var(--muted);
        font-size: 13px;
      }
      .toggles {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        color: var(--muted);
        font-size: 14px;
      }
      .toggles label {
        text-transform: none;
        letter-spacing: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.05);
        color: var(--muted);
        font-size: 13px;
      }
      @media (max-width: 640px) {
        .hero { padding: 20px; }
        .content { padding: 14px; }
        .actions { flex-direction: column; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <section class="hero">
          <h1>${escapeHtml(title)}</h1>
          <p class="sub">Mobile-browser voice MVP on top of clawphone. Speech stays in the browser; replies come back through HouseCarl on the Home PC.</p>
        </section>
        <section class="content">
          <section id="loginCard" class="card">
            <div class="pill">Private access only</div>
            <div id="loginStatus" class="status"></div>
            <form id="loginForm">
              <div>
                <label for="accessCode">Access Code</label>
                <input id="accessCode" name="code" type="password" autocomplete="current-password" placeholder="Enter browser access code">
              </div>
              <div class="actions">
                <button id="loginButton" type="submit">Unlock Voice Chat</button>
              </div>
            </form>
          </section>

          <section id="appCard" class="card hidden">
            <div class="actions">
              <button id="micButton" type="button">Start Listening</button>
              <button id="sendButton" type="button">Send Message</button>
              <button id="logoutButton" class="secondary" type="button">Lock</button>
            </div>
            <div class="toggles">
              <label><input id="autoSpeak" type="checkbox" checked> Speak replies automatically</label>
            </div>
            <div id="status" class="status"></div>
            <div id="transcript" class="transcript"></div>
            <div id="interim" class="meta"></div>
            <div>
              <label for="messageInput">Message</label>
              <textarea id="messageInput" placeholder="Type here or use the mic button."></textarea>
            </div>
          </section>
        </section>
      </div>
    </main>
    <script>
      const config = ${config};
      const browserPath = config.browserPath;
      const state = {
        authenticated: Boolean(config.authenticated),
        listening: false,
        pending: false,
        autoSpeak: true,
        authEpoch: 0,
        authTransition: false,
      };

      const loginCard = document.getElementById('loginCard');
      const appCard = document.getElementById('appCard');
      const loginForm = document.getElementById('loginForm');
      const accessCode = document.getElementById('accessCode');
      const micButton = document.getElementById('micButton');
      const sendButton = document.getElementById('sendButton');
      const logoutButton = document.getElementById('logoutButton');
      const autoSpeak = document.getElementById('autoSpeak');
      const statusEl = document.getElementById('status');
      const loginStatusEl = document.getElementById('loginStatus');
      const transcriptEl = document.getElementById('transcript');
      const interimEl = document.getElementById('interim');
      const messageInput = document.getElementById('messageInput');

      function setStatus(message, kind = '', target) {
        const el = target || statusEl;
        el.textContent = message || '';
        el.className = kind ? 'status ' + kind : 'status';
      }

      function renderAuth() {
        loginCard.classList.toggle('hidden', state.authenticated);
        appCard.classList.toggle('hidden', !state.authenticated);
        if (state.authenticated) messageInput.focus();
        else accessCode.focus();
      }

      function addBubble(role, text) {
        const el = document.createElement('div');
        el.className = 'bubble ' + role;
        el.textContent = text;
        transcriptEl.appendChild(el);
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }

      function speakReply(text) {
        if (!state.autoSpeak || !('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.pitch = 1;
        window.speechSynthesis.speak(utterance);
      }

      let activeChatController = null;

      async function postJson(path, payload, extraHeaders = {}, signal) {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...extraHeaders },
          credentials: 'same-origin',
          body: JSON.stringify(payload || {}),
          signal,
        });
        let body = {};
        try { body = await res.json(); } catch {}
        if (!res.ok) {
          const error = new Error(body.error || ('Request failed (' + res.status + ')'));
          error.status = res.status;
          throw error;
        }
        return body;
      }

      function cancelPendingChat() {
        if (activeChatController) activeChatController.abort();
        activeChatController = null;
        state.pending = false;
      }

      async function login(code) {
        const body = await postJson(browserPath + '/login', { code });
        state.authenticated = Boolean(body.ok);
        if (state.authenticated) state.authEpoch += 1;
        setStatus('Unlocked.', 'ok');
        renderAuth();
      }

      function resetConversationUi() {
        transcriptEl.textContent = '';
        interimEl.textContent = '';
        messageInput.value = '';
        setStatus('');
        setStatus('', '', loginStatusEl);
      }

      function stopRecognition() {
        if (recognition) {
          recognition.abort();
        }
        state.listening = false;
        micButton.textContent = 'Start Listening';
        interimEl.textContent = '';
      }

      async function logout() {
        if (!state.authenticated || state.authTransition) return;
        state.authTransition = true;

        const previousEpoch = state.authEpoch;
        state.authEpoch += 1;
        cancelPendingChat();
        stopRecognition();

        try {
          await postJson(browserPath + '/logout', {});
        } catch (err) {
          state.authEpoch = previousEpoch;
          state.authTransition = false;
          setStatus('Lock failed: ' + String(err.message || err), 'error');
          return;
        }

        state.authenticated = false;
        state.authTransition = false;
        window.speechSynthesis?.cancel?.();
        resetConversationUi();
        renderAuth();
        setStatus('Locked.', 'ok', loginStatusEl);
      }

      async function sendMessage(text) {
        const trimmed = String(text || '').trim();
        if (!state.authenticated || state.authTransition || !trimmed || state.pending) return;
        state.pending = true;
        const epoch = state.authEpoch;
        const controller = new AbortController();
        activeChatController = controller;
        setStatus('HouseCarl is thinking...');
        addBubble('user', trimmed);
        messageInput.value = '';
        interimEl.textContent = '';
        try {
          const body = await postJson(browserPath + '/chat', { text: trimmed }, {}, controller.signal);
          if (!state.authenticated || epoch !== state.authEpoch) return;
          const reply = String(body.reply || '').trim() || 'Okay.';
          addBubble('assistant', reply);
          setStatus('Reply ready.', 'ok');
          speakReply(reply);
        } catch (err) {
          if (err.name === 'AbortError') return;
          if (epoch !== state.authEpoch) return;
          if (err.status === 401) {
            stopRecognition();
            state.authenticated = false;
            window.speechSynthesis?.cancel?.();
            resetConversationUi();
            setStatus(String(err.message || err), 'error', loginStatusEl);
            renderAuth();
            return;
          }
          setStatus(String(err.message || err), 'error');
        } finally {
          if (activeChatController === controller) {
            activeChatController = null;
            state.pending = false;
          }
        }
      }

      function createRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
          setStatus('Speech recognition is not supported in this browser.', 'error');
          return null;
        }
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        recognition.addEventListener('start', () => {
          state.listening = true;
          micButton.textContent = 'Stop Listening';
          setStatus('Listening...');
        });
        recognition.addEventListener('result', (event) => {
          let interim = '';
          let finalText = '';
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const transcript = result && result[0] ? result[0].transcript : '';
            if (result.isFinal) finalText += transcript;
            else interim += transcript;
          }
          interimEl.textContent = interim ? 'Hearing: ' + interim.trim() : '';
          if (finalText.trim()) sendMessage(finalText);
        });
        recognition.addEventListener('error', (event) => {
          if (event.error !== 'aborted') {
            setStatus('Mic error: ' + event.error, 'error');
          }
        });
        recognition.addEventListener('end', () => {
          state.listening = false;
          micButton.textContent = 'Start Listening';
          if (!state.pending) setStatus('');
        });
        return recognition;
      }

      let recognition = createRecognition();

      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await login(accessCode.value);
          accessCode.value = '';
          setStatus('', '', loginStatusEl);
        } catch (err) {
          setStatus(String(err.message || err), 'error', loginStatusEl);
        }
      });

      micButton.addEventListener('click', () => {
        if (!recognition) recognition = createRecognition();
        if (!recognition) return;
        if (state.listening) {
          recognition.stop();
          return;
        }
        interimEl.textContent = '';
        recognition.start();
      });

      sendButton.addEventListener('click', () => sendMessage(messageInput.value));
      logoutButton.addEventListener('click', logout);
      autoSpeak.addEventListener('change', () => { state.autoSpeak = autoSpeak.checked; });
      messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          sendMessage(messageInput.value);
        }
      });

      renderAuth();
    </script>
  </body>
</html>`;
}
