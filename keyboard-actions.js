/* Enter uses the same visible action as the button. Long-form editors opt out. */
(function () {
  "use strict";
  const actions = {
    cityMessageInput: ["cityMessageSend", "send"],
    messageInput: ["sendBtn", "send"], nameInput: ["saveNameBtn", "go"],
    "priv-input": ["priv-send", "send"], "fc-input": ["fc-send", "send"],
    commentInput: ["sendCommentBtn", "send"], privateChatInput: ["privateChatSendBtn", "send"],
    bjChatInput: ["bjChatSendBtn", "send"], pkChatInput: ["pkChatSendBtn", "send"],
    csChatInput: ["csChatSendBtn", "send"], dmChatInput: ["dmChatSendBtn", "send"],
    imChatInput: ["imChatSendBtn", "send"], clueInput: ["clueSubmitBtn", "send"],
    mathAnswer: ["mathSubmit", "done"],
    bioInput: ["bioSaveBtn", "done", true], bioEditorInput: ["bioSaveBtn", "done", true],
    renameModalInput: ["renameModalSave", "done"], pcNickInput: ["pcNickSave", "done", true],
    peAge: ["peSave", "done", true], peCity: ["peSave", "done", true],
    peStudy: ["peSave", "done", true], peWork: ["peSave", "done", true],
    reportModalInput: ["reportModalSave", "send"], rmReportInput: ["rmReportSend", "send"],
    roomFormInput: ["roomFormSave", "done"], pollQuestion: ["pollCreate", "done"]
  };
  const auth = {
    "login-username": "login", "login-password": "login",
    "signup-username": "signup", "signup-password": "signup", "signup-confirm": "signup",
    "signup-age": "signup", "signup-city": "signup", "signup-study": "signup", "signup-work": "signup"
  };
  const composing = new WeakSet(), newline = new WeakSet(), deferred = new WeakMap(), lastAction = new WeakMap();
  function isReturnInput(event) { return /^(insertLineBreak|insertParagraph)$/.test(event.inputType) || (event.inputType === "insertText" && event.data === "\n"); }
  function actionFor(input) {
    if (!input || !/^(INPUT|TEXTAREA)$/.test(input.tagName)) return null;
    if (input.tagName === "INPUT" && !/^(text|search|email|password|number|url|tel)$/.test(input.type)) return null;
    if (auth[input.id]) {
      const group = auth[input.id], fields = group === "login" ? ["login-username", "login-password"] : ["signup-username", "signup-password", "signup-confirm"];
      return { button: document.getElementById(group + "-btn"), fields, hint: fields[fields.length - 1] === input.id || !fields.includes(input.id) ? "go" : "next", empty: true };
    }
    let config = actions[input.id];
    if (input.id === "guessInput") {
      const id = ["guessSubmitBtn"].find(id => document.getElementById(id));
      if (id) config = [id, "send"];
    }
    if (input.id === "chatInput") {
      const id = ["chatSendBtn", "sendBtn"].find(id => document.getElementById(id));
      if (id) config = [id, "send"];
    }
    if (config) return { button: document.getElementById(config[0]), hint: config[1], empty: !!config[2] };
    if (input.form?.hasAttribute("data-enter-submit")) return {
      button: input.form.querySelector('button[type="submit"],input[type="submit"]'), hint: input.getAttribute("enterkeyhint") || "done"
    };
    return null;
  }
  function hint(input) {
    const action = actionFor(input);
    if (action?.button) input.setAttribute("enterkeyhint", action.hint);
  }
  function isVisible(node) { return !!node && node.getClientRects().length > 0; }
  function invoke(input, action) {
    const button = action?.button;
    if (!button || input.disabled || input.readOnly || button.disabled || !isVisible(input) || !isVisible(button)) return;
    if (!action.empty && !input.value.trim()) return;
    if (action.fields) {
      const missing = action.fields.map(id => document.getElementById(id)).find(field => field && (field.type === "password" ? !field.value : !field.value.trim()));
      if (missing && missing !== input) { missing.focus(); return; }
    }
    const previous = lastAction.get(input), now = performance.now();
    const value = action.fields ? JSON.stringify(action.fields.map(id => document.getElementById(id)?.value || "")) : input.value;
    if (previous && previous.value === value && now - previous.at < 250) return;
    lastAction.set(input, { value, at: now });
    button.click();
  }
  document.addEventListener("focusin", event => hint(event.target));
  document.addEventListener("compositionstart", event => composing.add(event.target), true);
  document.addEventListener("compositionend", event => composing.delete(event.target), true);
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const input = event.target, action = actionFor(input); if (!action?.button) return;
    if (event.isComposing || event.keyCode === 229 || composing.has(input)) { event.stopImmediatePropagation(); return; }
    if (input.tagName === "TEXTAREA" && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      newline.add(input); event.stopImmediatePropagation(); return;
    }
    newline.delete(input); event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) invoke(input, action);
  }, true);
  document.addEventListener("keyup", event => { if (event.key === "Enter") newline.delete(event.target); }, true);
  document.addEventListener("beforeinput", event => {
    if (!isReturnInput(event)) { deferred.delete(event.target); return; }
    const input = event.target, action = actionFor(input);
    if (!action?.button || event.isComposing || composing.has(input) || newline.has(input)) return;
    if (!event.cancelable) { deferred.set(input, input.value); return; }
    event.preventDefault(); event.stopImmediatePropagation(); invoke(input, action);
  }, true);
  document.addEventListener("input", event => {
    const input = event.target;
    const action = actionFor(input);
    if (!isReturnInput(event) || !action?.button || event.isComposing || composing.has(input) || newline.has(input)) { deferred.delete(input); return; }
    if (deferred.has(input)) input.value = deferred.get(input);
    else {
      const cursor = input.selectionStart;
      if (input.tagName !== "TEXTAREA" || !cursor || input.value[cursor - 1] !== "\n") return;
      input.value = input.value.slice(0, cursor - 1) + input.value.slice(cursor);
      input.setSelectionRange(cursor - 1, cursor - 1);
    }
    deferred.delete(input); queueMicrotask(() => invoke(input, action));
  }, true);
  // Fields created later (game rounds and dialogs) receive their hint on focus.
  document.querySelectorAll("input,textarea").forEach(hint);
})();
