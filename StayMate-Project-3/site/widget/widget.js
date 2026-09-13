/* ============================================================
   StayMate — вбудований чат-віджет для сайту готелю
   Підключення на сайті готелю (Фаза 3.2 плану, канал "сайт готелю"):

   <script
     src="https://staymat.netlify.app/widget/widget.js"
     data-property="ваш-property-id"
     data-api="https://staymate-concierge-production.up.railway.app"
     data-title="Готель «Назва»"
     async>
   </script>

   Нічого більше вставляти не треба — скрипт сам малює кнопку-бульбашку
   в правому нижньому куті й вікно чату. Стилі ізольовані інлайново,
   щоб не залежати від CSS сайту готелю.
   ============================================================ */
(function () {
  var scriptTag = document.currentScript;
  if (!scriptTag) return;

  var propertyId = scriptTag.getAttribute('data-property');
  var apiBase = scriptTag.getAttribute('data-api');
  var title = scriptTag.getAttribute('data-title') || 'Чат з адміністратором';
  var accent = scriptTag.getAttribute('data-accent') || '#2f5d50';

  if (!propertyId || !apiBase) {
    console.error('[StayMate widget] Не вказано data-property або data-api у тезі <script>.');
    return;
  }

  var SESSION_KEY = 'staymate_widget_session_' + propertyId;
  var sessionId = null;
  try {
    sessionId = localStorage.getItem(SESSION_KEY);
  } catch (e) { /* приватний режим браузера — обійдемось без збереження сесії */ }
  if (!sessionId) {
    sessionId = 'w' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem(SESSION_KEY, sessionId); } catch (e) {}
  }

  var root = document.createElement('div');
  root.id = 'staymate-widget-root';
  document.addEventListener('DOMContentLoaded', mount);
  if (document.readyState !== 'loading') mount();

  function mount() {
    document.body.appendChild(root);
    build();
  }

  function build() {
    var style = document.createElement('style');
    style.textContent =
      '#staymate-widget-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '.sm-w-btn{width:58px;height:58px;border-radius:50%;background:' + accent + ';box-shadow:0 8px 24px rgba(0,0,0,.25);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;}' +
      '.sm-w-btn svg{width:26px;height:26px;}' +
      '.sm-w-panel{display:none;flex-direction:column;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 110px);background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.28);overflow:hidden;position:absolute;bottom:74px;right:0;}' +
      '.sm-w-panel.open{display:flex;}' +
      '.sm-w-head{background:' + accent + ';color:#fff;padding:14px 16px;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;}' +
      '.sm-w-head button{background:none;border:none;color:#fff;opacity:.85;cursor:pointer;font-size:18px;line-height:1;padding:2px;}' +
      '.sm-w-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f7f6f2;}' +
      '.sm-w-msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;}' +
      '.sm-w-msg.guest{align-self:flex-end;background:' + accent + ';color:#fff;border-bottom-right-radius:3px;}' +
      '.sm-w-msg.ai{align-self:flex-start;background:#fff;color:#1c2521;border:1px solid #e2e0d8;border-bottom-left-radius:3px;}' +
      '.sm-w-msg.pending{align-self:flex-start;color:#8a887f;font-style:italic;font-size:12.5px;}' +
      '.sm-w-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e0d8;background:#fff;}' +
      '.sm-w-foot input{flex:1;border:1px solid #dcd7cb;border-radius:100px;padding:9px 14px;font-size:13.5px;outline:none;}' +
      '.sm-w-foot button{background:' + accent + ';color:#fff;border:none;border-radius:100px;padding:0 16px;font-size:13px;font-weight:600;cursor:pointer;}' +
      '.sm-w-foot button:disabled{opacity:.5;cursor:default;}' +
      '@media (max-width:480px){.sm-w-panel{width:calc(100vw - 24px);right:-8px;}}';
    document.head.appendChild(style);

    root.innerHTML =
      '<div class="sm-w-panel" id="sm-w-panel">' +
        '<div class="sm-w-head"><span>' + escapeHtml(title) + '</span><button id="sm-w-close" aria-label="Закрити">×</button></div>' +
        '<div class="sm-w-body" id="sm-w-body"></div>' +
        '<div class="sm-w-foot">' +
          '<input id="sm-w-input" type="text" placeholder="Напишіть повідомлення..." maxlength="800">' +
          '<button id="sm-w-send">Надіслати</button>' +
        '</div>' +
      '</div>' +
      '<button class="sm-w-btn" id="sm-w-toggle" aria-label="' + escapeHtml(title) + '">' +
        '<svg viewBox="0 0 24 24" fill="none"><path d="M4 4h16v12H7l-3 3V4z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>' +
      '</button>';

    var panel = root.querySelector('#sm-w-panel');
    var toggleBtn = root.querySelector('#sm-w-toggle');
    var closeBtn = root.querySelector('#sm-w-close');
    var body = root.querySelector('#sm-w-body');
    var input = root.querySelector('#sm-w-input');
    var sendBtn = root.querySelector('#sm-w-send');
    var greeted = false;

    toggleBtn.addEventListener('click', function () {
      panel.classList.toggle('open');
      if (panel.classList.contains('open') && !greeted) {
        greeted = true;
        addMessage('ai', 'Вітаю! Я віртуальний адміністратор. Запитайте про наявність номерів, ціни або умови заїзду.');
      }
    });
    closeBtn.addEventListener('click', function () { panel.classList.remove('open'); });

    function addMessage(who, text) {
      var el = document.createElement('div');
      el.className = 'sm-w-msg ' + who;
      el.textContent = text;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      return el;
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMessage('guest', text);
      sendBtn.disabled = true;
      var pending = addMessage('pending', 'Друкує…');

      fetch(apiBase.replace(/\/+$/, '') + '/webhook/website/' + encodeURIComponent(propertyId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, message: text }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          pending.remove();
          sendBtn.disabled = false;
          if (data && data.reply) {
            addMessage('ai', data.reply);
          } else {
            addMessage('ai', 'Вибачте, сталася технічна помилка. Спробуйте, будь ласка, ще раз.');
          }
        })
        .catch(function () {
          pending.remove();
          sendBtn.disabled = false;
          addMessage('ai', 'Не вдалося зв\'язатися з сервером. Перевірте інтернет-з\'єднання і спробуйте ще раз.');
        });
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
