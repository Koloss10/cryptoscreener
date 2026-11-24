// Гарячі клавіші терміналу. classify() — чиста функція (tests/hotkeys.test.js), решта — прив'язка до сторінки.
//   Пробіл / ↓ — наступна монета, ↑ — попередня; Alt + 1…6 — таймфрейм (15m, 1H, 4H, 1D, 1W, 1M); Shift + D — шар «Плотності».
(function (root) {
    'use strict';

    const TYPING_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];
    const ACTIVATING_TAGS = ['BUTTON', 'A', 'SUMMARY'];       // Пробіл на них — це натискання, не навігація

    // e: { key, code, altKey, shiftKey, ctrlKey, metaKey, defaultPrevented, target: { tagName, isContentEditable } }
    // Повертає { type: 'coin', dir } | { type: 'tf', index } | { type: 'layer', key } | null
    function classify(e) {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey) return null;
        const t = e.target || {}, tag = String(t.tagName || '').toUpperCase();
        if (t.isContentEditable || TYPING_TAGS.includes(tag)) return null;
        if (e.altKey && !e.shiftKey) {
            const m = /^Digit([1-6])$/.exec(e.code || '');      // за фізичною клавішею: на Mac Alt+цифра дає інший символ
            return m ? { type: 'tf', index: Number(m[1]) - 1 } : null;
        }
        if (e.altKey) return null;
        if (e.shiftKey) return e.code === 'KeyD' ? { type: 'layer', key: 'dens' } : null;
        if (e.key === 'ArrowUp') return { type: 'coin', dir: -1 };
        if (e.key === 'ArrowDown') return { type: 'coin', dir: 1 };
        if (e.key === ' ' || e.code === 'Space') return ACTIVATING_TAGS.includes(tag) ? null : { type: 'coin', dir: 1 };
        return null;
    }

    // Наступний/попередній елемент по колу
    const step = (index, dir, length) => (length ? (index + dir + length) % length : -1);

    const api = { classify, step };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
    root.Hotkeys = api;

    const terminalOpen = () => { const v = document.getElementById('view-terminal'); return !!v && !v.classList.contains('hidden'); };

    function apply(action) {
        if (action.type === 'coin') {
            const sel = document.getElementById('coinSelect');
            const options = [...sel.options].map(o => o.value);
            const next = step(options.indexOf(sel.value), action.dir, options.length);
            if (next >= 0) root.changeSymbol(options[next]);
        } else if (action.type === 'tf') {
            const btn = document.querySelectorAll('.tf-b')[action.index];
            if (btn) btn.click();
        } else if (action.type === 'layer') {
            const btn = [...document.querySelectorAll('#layerBar button')].find(b => (b.getAttribute('onclick') || '').includes(`'${action.key}'`));
            if (btn) btn.click();
        }
    }

    document.addEventListener('keydown', e => {
        if (!terminalOpen()) return;
        const action = classify(e);
        if (!action) return;
        e.preventDefault();                                      // Пробіл і стрілки не гортають сторінку
        apply(action);
    });
})(typeof window !== 'undefined' ? window : globalThis);
