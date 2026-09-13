/* ------------------------------------------------------------------
 * AI Quick Solver (qa-solver.js) - STEALTH & ISOLATED VERSION
 * 
 * Các tính năng bảo vệ tàng hình (Anti-Detection / Stealth):
 * 1. Closed Shadow DOM (mode: 'closed'): Toàn bộ UI (card giải, overlay,
 *    nút) nằm hoàn toàn trong shadow root đóng kín. Website gọi querySelector,
 *    getElementById hay quét element.shadowRoot đều nhận về null / không thấy.
 * 2. Ngắt bắt phím (stopImmediatePropagation): Khi bấm Alt+Q, Alt+Shift+Q
 *    hoặc Esc, event bị chặn ngay từ capture phase, trang web không bắt được
 *    log phím bấm.
 * 3. Miễn nhiễm CSS: CSS của trang web thi không thể làm vỡ giao diện card.
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  // Chỉ chạy ở window top
  if (window !== window.top) return;

  let shadowHost = null;
  let shadowRoot = null;
  let activePanel = null;
  let activeCropOverlay = null;
  let miniTriggerBtn = null;

  /* ------------------------------------------------------------------
   * Khởi tạo Closed Shadow DOM container (ẩn hoàn toàn với website)
   * ------------------------------------------------------------------ */
  function ensureShadowRoot() {
    if (!shadowHost || !shadowHost.isConnected) {
      shadowHost = document.createElement('div');
      // Không đặt id/class dễ bị quét, gán style tối giản
      Object.assign(shadowHost.style, {
        all: 'initial',
        position: 'static',
        zIndex: '2147483647',
      });
      // mode: 'closed' -> host.shadowRoot sẽ luôn trả về null với script trang web
      shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

      // Inject style reset cơ bản vào bên trong Shadow DOM
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes nptFadeIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes nptPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `;
      shadowRoot.appendChild(style);

      const targetParent = document.body || document.documentElement;
      if (targetParent) {
        targetParent.appendChild(shadowHost);
      }
    }
    return shadowRoot;
  }

  /* ------------------------------------------------------------------
   * Helper: Crop ảnh canvas
   * ------------------------------------------------------------------ */
  function cropImage(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const vW = window.innerWidth || document.documentElement.clientWidth || 1;
          const vH = window.innerHeight || document.documentElement.clientHeight || 1;
          const scaleX = img.naturalWidth / vW;
          const scaleY = img.naturalHeight / vH;

          const cropX = Math.max(0, Math.round(rect.x * scaleX));
          const cropY = Math.max(0, Math.round(rect.y * scaleY));
          const cropW = Math.max(1, Math.min(img.naturalWidth - cropX, Math.round(rect.width * scaleX)));
          const cropH = Math.max(1, Math.min(img.naturalHeight - cropY, Math.round(rect.height * scaleY)));

          const canvas = document.createElement('canvas');
          canvas.width = cropW;
          canvas.height = cropH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          resolve(canvas.toDataURL('image/png'));
        } catch (_) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ------------------------------------------------------------------
   * Helper: Format Markdown cơ bản (bold, newlines)
   * ------------------------------------------------------------------ */
  function formatMarkdown(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    let safe = div.innerHTML;
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\n/g, '<br>');
    return safe;
  }

  /* ------------------------------------------------------------------
   * Toast thông báo nhẹ
   * ------------------------------------------------------------------ */
  function showToast(message, duration = 2800) {
    const root = ensureShadowRoot();
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '30px',
      left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: isDark ? '#1f2937' : '#111827',
      color: '#ffffff',
      padding: '10px 18px',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '500',
      zIndex: '2147483647',
      boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
      transition: 'opacity 0.2s ease',
      pointerEvents: 'none',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      animation: 'nptFadeIn 0.15s ease-out',
    });
    root.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => {
        try { toast.remove(); } catch (_) {}
      }, 250);
    }, duration);
  }

  /* ------------------------------------------------------------------
   * Floating Card: Hiển thị đáp án trong Closed Shadow DOM
   * ------------------------------------------------------------------ */
  function showSolverCard({ title = 'AI Quick Solver', initialStatus = 'Đang phân tích câu hỏi...' }) {
    closeSolverCard();

    const root = ensureShadowRoot();
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const panel = document.createElement('div');
    activePanel = panel;

    Object.assign(panel.style, {
      position: 'fixed',
      top: '75px',
      right: '25px',
      width: '360px',
      maxHeight: '480px',
      backgroundColor: isDark ? '#1e293b' : '#ffffff',
      color: isDark ? '#f8fafc' : '#0f172a',
      border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      borderRadius: '12px',
      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.25), 0 8px 10px -6px rgba(0, 0, 0, 0.2)',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '14px',
      overflow: 'hidden',
      userSelect: 'text',
      animation: 'nptFadeIn 0.15s ease-out',
    });

    // 1. Header kéo thả
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '10px 14px',
      backgroundColor: isDark ? '#0f172a' : '#f1f5f9',
      borderBottom: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      cursor: 'move',
      userSelect: 'none',
    });

    const headerLeft = document.createElement('div');
    headerLeft.style.display = 'flex';
    headerLeft.style.alignItems = 'center';
    headerLeft.style.gap = '8px';

    const icon = document.createElement('span');
    icon.textContent = '💡';
    icon.style.fontSize = '16px';

    const headerTitle = document.createElement('span');
    headerTitle.textContent = title;
    headerTitle.style.fontWeight = '600';
    headerTitle.style.fontSize = '13px';
    headerTitle.style.letterSpacing = '0.3px';

    headerLeft.appendChild(icon);
    headerLeft.appendChild(headerTitle);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Đóng (Esc)';
    Object.assign(closeBtn.style, {
      border: 'none',
      background: 'transparent',
      color: isDark ? '#94a3b8' : '#64748b',
      cursor: 'pointer',
      fontSize: '14px',
      padding: '4px 8px',
      borderRadius: '4px',
      lineHeight: '1',
    });
    closeBtn.addEventListener('click', closeSolverCard);

    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Xử lý kéo thả Panel
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;
      panel.style.right = 'auto';
      panel.style.left = initialLeft + 'px';
      panel.style.top = initialTop + 'px';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      panel.style.left = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + deltaX)) + 'px';
      panel.style.top = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + deltaY)) + 'px';
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // 2. Nội dung Body
    const body = document.createElement('div');
    Object.assign(body.style, {
      padding: '14px',
      overflowY: 'auto',
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      lineHeight: '1.5',
    });

    const statusEl = document.createElement('div');
    statusEl.innerHTML = `<span style="display:inline-block; animation:nptPulse 1.2s infinite">⏳</span> ${initialStatus}`;
    statusEl.style.color = isDark ? '#94a3b8' : '#64748b';
    statusEl.style.fontSize = '13px';
    body.appendChild(statusEl);

    panel.appendChild(body);

    // 3. Footer (Sao chép & Thoát)
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '8px 14px',
      borderTop: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: isDark ? '#111827' : '#f8fafc',
    });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '📋 Sao chép';
    copyBtn.title = 'Copy đáp án vào clipboard';
    Object.assign(copyBtn.style, {
      padding: '6px 12px',
      border: `1px solid ${isDark ? '#475569' : '#cbd5e1'}`,
      backgroundColor: isDark ? '#1e293b' : '#ffffff',
      color: isDark ? '#f1f5f9' : '#1e293b',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '500',
    });

    let currentAnswerText = '';
    copyBtn.addEventListener('click', async () => {
      if (!currentAnswerText) return;
      try {
        await navigator.clipboard.writeText(currentAnswerText);
        copyBtn.textContent = '✔ Đã chép!';
        setTimeout(() => { copyBtn.textContent = '📋 Sao chép'; }, 1800);
      } catch (_) {
        showToast('Không thể sao chép vào clipboard');
      }
    });

    const hint = document.createElement('span');
    hint.textContent = 'Esc để đóng';
    hint.style.fontSize = '11px';
    hint.style.color = isDark ? '#64748b' : '#94a3b8';

    footer.appendChild(copyBtn);
    footer.appendChild(hint);
    panel.appendChild(footer);

    root.appendChild(panel);

    return {
      setResult: ({ answer, providerLabel }) => {
        currentAnswerText = answer;
        body.innerHTML = '';

        if (providerLabel) {
          headerTitle.textContent = `${title} (${providerLabel})`;
        }

        const lines = answer.split('\n');
        const firstLine = (lines[0] || '').trim();
        const explanation = lines.slice(1).join('\n').trim();

        // Khung đáp án nổi bật
        const answerBox = document.createElement('div');
        Object.assign(answerBox.style, {
          backgroundColor: isDark ? '#064e3b' : '#ecfdf5',
          border: `1px solid ${isDark ? '#059669' : '#a7f3d0'}`,
          color: isDark ? '#6ee7b7' : '#065f46',
          padding: '10px 14px',
          borderRadius: '8px',
          fontWeight: '600',
          fontSize: '15px',
        });
        answerBox.innerHTML = formatMarkdown(firstLine);
        body.appendChild(answerBox);

        if (explanation) {
          const expBox = document.createElement('div');
          expBox.style.fontSize = '13px';
          expBox.style.color = isDark ? '#cbd5e1' : '#334155';
          expBox.innerHTML = formatMarkdown(explanation);
          body.appendChild(expBox);
        }
      },
      setError: (errorMessage) => {
        body.innerHTML = '';
        const errBox = document.createElement('div');
        Object.assign(errBox.style, {
          backgroundColor: isDark ? '#7f1d1d' : '#fef2f2',
          border: `1px solid ${isDark ? '#991b1b' : '#fecaca'}`,
          color: isDark ? '#fca5a5' : '#991b1b',
          padding: '10px 12px',
          borderRadius: '8px',
          fontSize: '13px',
        });
        errBox.textContent = `Lỗi: ${errorMessage}`;
        body.appendChild(errBox);
      }
    };
  }

  function closeSolverCard() {
    if (activePanel) {
      try { activePanel.remove(); } catch (_) {}
      activePanel = null;
    }
  }

  /* ------------------------------------------------------------------
   * Giải câu hỏi dạng Text (bôi đen)
   * ------------------------------------------------------------------ */
  async function solveTextQuestion(questionText) {
    const text = String(questionText || '').trim();
    if (!text) {
      showToast('💡 Bôi đen câu hỏi rồi bấm Alt+Q (hoặc Alt+Shift+Q để quét ảnh)');
      return;
    }

    const card = showSolverCard({
      title: 'AI Quick Solver',
      initialStatus: 'Đang giải câu hỏi...'
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'qaSolveQuestion',
        payload: { text }
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'Không nhận được phản hồi từ AI');
      }

      card.setResult({
        answer: response.answer,
        providerLabel: response.providerLabel,
      });
    } catch (err) {
      card.setError(err.message || String(err));
    }
  }

  /* ------------------------------------------------------------------
   * Giải câu hỏi dạng Ảnh màn hình (OCR Vision - Alt+Shift+Q)
   * Đặt hoàn toàn trong Closed Shadow DOM
   * ------------------------------------------------------------------ */
  function startCropSolver() {
    closeCropOverlay();
    const root = ensureShadowRoot();

    activeCropOverlay = document.createElement('div');
    Object.assign(activeCropOverlay.style, {
      position: 'fixed',
      top: '0', left: '0', width: '100vw', height: '100vh',
      zIndex: '2147483647',
      cursor: 'crosshair',
      backgroundColor: 'rgba(0, 0, 0, 0.35)',
      userSelect: 'none',
    });

    const selectionBox = document.createElement('div');
    Object.assign(selectionBox.style, {
      position: 'absolute',
      border: '2px dashed #10b981',
      backgroundColor: 'rgba(16, 185, 129, 0.15)',
      display: 'none',
      pointerEvents: 'none',
    });
    activeCropOverlay.appendChild(selectionBox);

    const guideHeader = document.createElement('div');
    guideHeader.textContent = '💡 Khoanh vùng câu hỏi để AI giải ngay (Esc để thoát)';
    Object.assign(guideHeader.style, {
      position: 'absolute',
      top: '20px', left: '50%',
      transform: 'translateX(-50%)',
      backgroundColor: '#0f172a',
      color: '#ffffff',
      padding: '8px 18px',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: '500',
      fontFamily: 'sans-serif',
      boxShadow: '0 4px 6px -1px rgba(0,0,0,0.3)',
    });
    activeCropOverlay.appendChild(guideHeader);

    let isSelecting = false;
    let startX = 0;
    let startY = 0;

    activeCropOverlay.addEventListener('mousedown', (e) => {
      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = startX + 'px';
      selectionBox.style.top = startY + 'px';
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    });

    activeCropOverlay.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      const curX = e.clientX;
      const curY = e.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      selectionBox.style.left = x + 'px';
      selectionBox.style.top = y + 'px';
      selectionBox.style.width = w + 'px';
      selectionBox.style.height = h + 'px';
    });

    activeCropOverlay.addEventListener('mouseup', async (e) => {
      if (!isSelecting) return;
      isSelecting = false;

      const curX = e.clientX;
      const curY = e.clientY;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      if (w < 15 || h < 15) {
        closeCropOverlay();
        return;
      }

      guideHeader.textContent = 'Đang chụp và đọc hình ảnh...';
      activeCropOverlay.style.opacity = '0';

      try {
        await new Promise(r => setTimeout(r, 120));
        const capture = await chrome.runtime.sendMessage({ type: 'ocrTakeScreenshot' });
        if (!capture || !capture.ok) {
          throw new Error(capture?.error || 'Không chụp được màn hình');
        }

        const croppedDataUrl = await cropImage(capture.dataUrl, { x, y, width: w, height: h });
        closeCropOverlay();

        const card = showSolverCard({
          title: 'AI Quick Solver (Vision)',
          initialStatus: 'AI đang phân tích câu hỏi trong hình ảnh...'
        });

        const response = await chrome.runtime.sendMessage({
          type: 'qaSolveQuestion',
          payload: { imageBase64: croppedDataUrl }
        });

        if (!response || !response.ok) {
          throw new Error(response?.error || 'Không nhận được phản hồi từ AI');
        }

        card.setResult({
          answer: response.answer,
          providerLabel: response.providerLabel,
        });
      } catch (err) {
        closeCropOverlay();
        showToast(`Lỗi: ${err.message || String(err)}`);
      }
    });

    root.appendChild(activeCropOverlay);
  }

  function closeCropOverlay() {
    if (activeCropOverlay) {
      try { activeCropOverlay.remove(); } catch (_) {}
      activeCropOverlay = null;
    }
  }

  /* ------------------------------------------------------------------
   * Mini Button Tooltip (Nằm trong Shadow DOM)
   * ------------------------------------------------------------------ */
  function removeMiniTrigger() {
    if (miniTriggerBtn) {
      try { miniTriggerBtn.remove(); } catch (_) {}
      miniTriggerBtn = null;
    }
  }

  document.addEventListener('mouseup', (e) => {
    // Nếu click vào Shadow DOM thì không xóa
    if (shadowHost && shadowHost.contains(e.target)) return;

    setTimeout(() => {
      const selection = window.getSelection();
      const text = (selection?.toString() || '').trim();

      // Chỉ hiện khi bôi đen chuỗi đủ dài (> 10 ký tự)
      if (text && text.length > 10 && selection.rangeCount > 0) {
        removeMiniTrigger();

        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;

        const root = ensureShadowRoot();
        const btn = document.createElement('button');
        miniTriggerBtn = btn;
        btn.innerHTML = '💡 <strong>Giải nhanh</strong> (Alt+Q)';
        btn.title = 'Nhờ AI giải câu hỏi này (Alt+Q)';

        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        Object.assign(btn.style, {
          position: 'fixed',
          top: Math.max(10, rect.top - 36) + 'px',
          left: Math.max(10, Math.min(window.innerWidth - 180, rect.left)) + 'px',
          backgroundColor: isDark ? '#0f172a' : '#ffffff',
          color: isDark ? '#38bdf8' : '#0284c7',
          border: `1px solid ${isDark ? '#38bdf8' : '#0284c7'}`,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          borderRadius: '20px',
          padding: '4px 12px',
          fontSize: '12px',
          cursor: 'pointer',
          zIndex: '2147483646',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          userSelect: 'none',
          animation: 'nptFadeIn 0.12s ease-out',
        });

        btn.addEventListener('mousedown', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          removeMiniTrigger();
          solveTextQuestion(text);
        });

        root.appendChild(btn);
      } else {
        removeMiniTrigger();
      }
    }, 15);
  });

  /* ------------------------------------------------------------------
   * Lắng nghe phím tắt ở Capture Phase (Chặn trang web log phím)
   * ------------------------------------------------------------------ */
  window.addEventListener('keydown', (e) => {
    // Phím Escape: đóng mọi panel/overlay và triệt tiêu event
    if (e.key === 'Escape') {
      let handled = false;
      if (activeCropOverlay) {
        closeCropOverlay();
        handled = true;
      }
      if (activePanel) {
        closeSolverCard();
        handled = true;
      }
      if (miniTriggerBtn) {
        removeMiniTrigger();
        handled = true;
      }
      if (handled) {
        // Ngăn trang web thi bắt được sự kiện Esc
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }

    // Phím Alt + Q hoặc Alt + Shift + Q
    if (e.altKey && (e.key === 'q' || e.key === 'Q')) {
      // Ngăn chặn trang web thi phát hiện tổ hợp phím này
      e.preventDefault();
      e.stopImmediatePropagation();
      removeMiniTrigger();

      if (e.shiftKey) {
        // Alt + Shift + Q: Khoanh vùng giải ảnh
        startCropSolver();
      } else {
        // Alt + Q: Bôi đen giải chữ
        const selected = (window.getSelection()?.toString() || '').trim();
        if (selected) {
          solveTextQuestion(selected);
        } else {
          showToast('💡 Bôi đen câu hỏi rồi bấm Alt+Q (hoặc bấm Alt+Shift+Q để quét ảnh)');
        }
      }
    }
  }, true); // true = capture phase (bắt trước khi tới trang web)

})();
