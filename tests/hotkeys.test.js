const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, step } = require('../hotkeys.js');

const ev = (over = {}) => ({ key: '', code: '', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, target: { tagName: 'BODY' }, ...over });

test('Space and ArrowDown go to the next coin, ArrowUp to the previous one', () => {
    assert.deepEqual(classify(ev({ key: ' ', code: 'Space' })), { type: 'coin', dir: 1 });
    assert.deepEqual(classify(ev({ key: 'ArrowDown', code: 'ArrowDown' })), { type: 'coin', dir: 1 });
    assert.deepEqual(classify(ev({ key: 'ArrowUp', code: 'ArrowUp' })), { type: 'coin', dir: -1 });
});

test('Alt+1…6 pick a timeframe by the physical key; Alt+7, Alt+0 and Alt+Shift+digit do nothing', () => {
    for (let i = 1; i <= 6; i++) assert.deepEqual(classify(ev({ altKey: true, code: 'Digit' + i, key: '¡' })), { type: 'tf', index: i - 1 });
    assert.equal(classify(ev({ altKey: true, code: 'Digit7' })), null);
    assert.equal(classify(ev({ altKey: true, code: 'Digit0' })), null);
    assert.equal(classify(ev({ altKey: true, shiftKey: true, code: 'Digit1' })), null);
});

test('Shift+D toggles densities; plain D, Shift+B and other letters are ignored', () => {
    assert.deepEqual(classify(ev({ shiftKey: true, code: 'KeyD', key: 'D' })), { type: 'layer', key: 'dens' });
    assert.equal(classify(ev({ code: 'KeyD', key: 'd' })), null);
    assert.equal(classify(ev({ shiftKey: true, code: 'KeyB', key: 'B' })), null);
});

test('typing in fields, ctrl/meta shortcuts and already handled events are never hijacked', () => {
    for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(classify(ev({ key: ' ', code: 'Space', target: { tagName } })), null, tagName);
    assert.equal(classify(ev({ key: 'ArrowDown', target: { tagName: 'DIV', isContentEditable: true } })), null);
    assert.equal(classify(ev({ key: 'ArrowDown', ctrlKey: true })), null);
    assert.equal(classify(ev({ key: 'ArrowDown', metaKey: true })), null);
    assert.equal(classify(ev({ key: 'ArrowDown', defaultPrevented: true })), null);
});

test('Space on a focused button or link still activates it, arrows still navigate', () => {
    for (const tagName of ['BUTTON', 'A', 'SUMMARY']) {
        assert.equal(classify(ev({ key: ' ', code: 'Space', target: { tagName } })), null, tagName);
        assert.deepEqual(classify(ev({ key: 'ArrowDown', target: { tagName } })), { type: 'coin', dir: 1 }, tagName);
    }
});

test('step wraps around both ends and survives an empty list', () => {
    assert.equal(step(0, -1, 5), 4);
    assert.equal(step(4, 1, 5), 0);
    assert.equal(step(2, 1, 5), 3);
    assert.equal(step(-1, 1, 5), 0);          // поточної монети немає в списку → перша
    assert.equal(step(0, 1, 0), -1);
});
