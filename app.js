/* Organiseur MD : interface locale, authentification et synchronisation Supabase. */
// La page reste utilisable (thème, mini-jeu, interface locale) même si le
// fichier de configuration n'a pas encore été publié sur GitHub Pages.
const { url: SUPABASE_URL = "", publishableKey: SUPABASE_PUBLISHABLE_KEY = "" } = window.SUPABASE_CONFIG || {};
const credentialsConfigured = SUPABASE_URL.startsWith("https://") && SUPABASE_PUBLISHABLE_KEY.length > 20;
const supabaseLibraryAvailable = typeof window.supabase?.createClient === "function";
const configured = credentialsConfigured && supabaseLibraryAvailable;
const sbClient = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) : null;
const $ = (selector) => document.querySelector(selector);
const DB_NAME = "organiseur-bd";
const QUEUE = "queue";
const EMAIL_COOLDOWN_MS = 60_000;
const EMAIL_COOLDOWN_KEY = "organiseur-email-cooldown-until";
const MARKDOWN_DRAFT_KEY = "organiseur-markdown-draft";
const NOTE_PARENT_MARKER = /^<!--organiseur-parent:([a-f0-9-]{36})-->/i;
const TASK_PARENT_MARKER = /^<!--organiseur-task-parent:([a-f0-9-]{36})-->/i;
const NOTE_META_MARKER = /^<!--organiseur-note-meta:([^>]+)-->/i;
const TASK_META_MARKER = /^<!--organiseur-task-meta:([^>]+)-->/i;
const ARCHIVE_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const MONTHS = ["JANVIER", "FÉVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOÛT", "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DÉCEMBRE"];

let tasks = [], notes = [], selectedNoteId = null, user = null, noteTimer = null, todoChannel = null, noteChannel = null, noteSearch = "";
let syncInFlight = null, syncRequested = false;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let emailCooldownTimer = null, bubbleTimer = null, bubbleScore = 0, completedMissions = 0, bubbleSerial = 0;
let cipher = ["✦", "◈", "⌁"];
const ARCHIVE_REWARDS = ["Insigne du cartographe", "Lentille de terrain", "Boussole méridienne", "Sceau des archives"];
let markdownTimer = null, markdownPreviewVisible = false;
let draggedNoteId = null;
let draggedTaskId = null;
let touchDraggedTaskId = null, touchNestTimer = null, touchDropTarget = null;
let dailyArchiveTimer = null;
let taskArchiveView = false, noteArchiveView = false;

// --- IndexedDB : la copie locale et la file d'attente hors ligne. ---
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => ["tasks", "notes", QUEUE].forEach((name) => {
      if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function store(name, mode, action) {
  const database = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    const request = action(transaction.objectStore(name));
    transaction.oncomplete = () => { database.close(); resolve(request?.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}
const all = (name) => store(name, "readonly", (s) => s.getAll());
const put = (name, value) => store(name, "readwrite", (s) => s.put(value));
const drop = (name, id) => store(name, "readwrite", (s) => s.delete(id));
const clearStore = (name) => store(name, "readwrite", (s) => s.clear());

// --- État, thème et navigation. ---
function updateClock() {
  const now = new Date(); const day = now.toLocaleDateString("fr-FR", { weekday: "long" }).toUpperCase();
  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  $("#clock").textContent = `${day} · ${time}`; $("#clock").setAttribute("aria-label", `${day}, ${time}`);
}
function authRedirectUrl() {
  // Conserve exactement le dossier publié : /organiseur-bd/ sur GitHub Pages,
  // ou /index.html en local. L'ancien calcul pouvait supprimer ce dossier.
  return `${location.origin}${location.pathname}`;
}
function toggleNavigation() {
  const navigation = $("#main-nav");
  const collapsed = navigation.classList.toggle("is-collapsed");
  const label = collapsed ? "Afficher le menu" : "Masquer le menu";
  $("#brand-reveal").setAttribute("aria-expanded", String(!collapsed));
  $("#brand-reveal").title = label;
}
function status(message) {
  const icon = $("#sync-status");
  const states = message.startsWith("Synchronisé") ? ["✓", "Synchronisation terminée", "ready"]
    : message.startsWith("Synchronisation") ? ["↻", "Synchronisation en cours", "working"]
      : message.startsWith("Hors ligne") ? ["⌁", "Hors ligne : envoi différé", "offline"]
        : message.startsWith("Erreur") ? ["!", "Erreur de stockage local", "error"]
          : ["◎", "Connexion requise", "idle"];
  icon.textContent = states[0]; icon.title = states[1]; icon.setAttribute("aria-label", states[1]); icon.dataset.state = states[2];
}
function account(sessionUser) {
  user = sessionUser;
  $("#login-screen").classList.toggle("hidden", !!user);
  $("#app-shell").classList.toggle("hidden", !user);
  $("#signout").classList.toggle("hidden", !user);
  if (user) pauseWaitGame(); else startWaitGame();
  status(!configured ? "Erreur" : user ? "Synchronisé" : "Connexion requise");
  if (!configured) $("#login-message").textContent = credentialsConfigured
    ? "Le module de connexion n’a pas été chargé. Vérifiez votre connexion Internet puis rechargez la page."
    : "La configuration Supabase est indisponible.";
}
function route() {
  const view = ["notes", "markdown", "calendar", "maintenance"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "todos";
  ["todos", "notes", "markdown", "calendar", "maintenance"].forEach((id) => $("#" + id).classList.toggle("hidden", id !== view));
  document.querySelectorAll("[data-link]").forEach((link) => link.classList.toggle("active", link.dataset.link === view));
  if (view === "markdown") renderMarkdownPreview();
}

// --- Notes riches : seul un sous-ensemble HTML sûr est conservé lors d'un collage. ---
const NOTE_TAGS = new Set(["A", "ASIDE", "B", "BLOCKQUOTE", "BR", "CODE", "DEL", "DIV", "EM", "H1", "H2", "H3", "H4", "HR", "I", "LI", "OL", "P", "PRE", "S", "SPAN", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "U", "UL"]);
const escapeHtml = (value) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
function safeUrl(value) { try { const url = new URL(value, location.href); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : ""; } catch { return ""; } }
function normaliseLanguage(value = "") {
  const language = value.toLowerCase().replace(/^language-/, "").replace(/^lang-/, "").trim();
  const aliases = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash", html: "html", xml: "html", yml: "yaml", md: "markdown", csharp: "csharp", cs: "csharp" };
  return aliases[language] || language || "text";
}
function languageFromElement(element) {
  const declared = element.getAttribute("data-language") || element.getAttribute("data-code-language")
    || [...element.classList].find((name) => /^(?:language|lang)-/i.test(name)) || "";
  return normaliseLanguage(declared);
}
function sanitizeNoteHtml(html) {
  const documentCopy = new DOMParser().parseFromString(html, "text/html");
  const clean = (node) => {
    [...node.children].forEach((child) => {
      clean(child);
      if (!NOTE_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); return; }
      const href = child.tagName === "A" ? safeUrl(child.getAttribute("href") || child.getAttribute("data-safe-href") || "") : "";
      // Gemini et les autres IA emploient souvent un simple <div> mis en forme
      // pour les avertissements. On conserve le sens, pas leur CSS externe.
      const isCallout = child.tagName === "ASIDE" || child.tagName === "BLOCKQUOTE"
        || child.classList.contains("note-callout") || child.hasAttribute("data-note-callout")
        || /^(?:⚠️?|❗|ℹ️?|NOTE\s*:|ATTENTION\s*:|IMPORTANT\s*:)/i.test(child.textContent.trim());
      const listStart = child.tagName === "OL" && /^\d+$/.test(child.getAttribute("start") || "") ? child.getAttribute("start") : "";
      const orderedStep = child.tagName === "LI" && child.parentElement?.tagName === "OL"
        ? Number(child.getAttribute("data-step") || child.getAttribute("value") || Number(child.parentElement.getAttribute("start") || 1) + [...child.parentElement.children].filter((item) => item.tagName === "LI").indexOf(child)) : 0;
      const codeLanguage = ["PRE", "CODE"].includes(child.tagName) ? languageFromElement(child) : "";
      const tokenClass = child.tagName === "SPAN" && [...child.classList].find((name) => /^token-(?:comment|string|keyword|number|property|tag)$/.test(name));
      [...child.attributes].forEach((attribute) => child.removeAttribute(attribute.name));
      if (child.tagName === "A") {
        if (href) { child.href = href; child.target = "_blank"; child.rel = "noopener noreferrer"; }
      }
      if (child.tagName === "OL") { child.className = "note-steps"; if (listStart) child.start = Number(listStart); }
      if (child.tagName === "UL") child.className = "note-bullets";
      if (isCallout) child.classList.add("note-callout");
      if (codeLanguage) child.dataset.language = codeLanguage;
      if (tokenClass) child.className = tokenClass;
      if (orderedStep > 0) child.dataset.step = String(orderedStep);
    });
  };
  clean(documentCopy.body);
  return documentCopy.body.innerHTML;
}
function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) => `<a data-safe-href="${href}">${label}</a>`);
}
function proseToHtml(piece) {
    const lines = piece.split("\n"); let list = null; const output = [];
    const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
    lines.forEach((line) => {
      const ordered = line.match(/^\s*(\d+)[.)]\s*(\S(?:.*))$/); const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      if (ordered || bullet) { const type = ordered ? "ol" : "ul"; if (type !== list) { closeList(); output.push(ordered ? `<ol class="note-steps" start="${ordered[1]}">` : '<ul class="note-bullets">'); list = type; } output.push(ordered ? `<li data-step="${ordered[1]}">${inlineMarkdown(ordered[2])}</li>` : `<li>${inlineMarkdown(bullet[1])}</li>`); return; }
      closeList();
      if (/^#{1,4}\s+/.test(line)) { const level = Math.min(4, line.match(/^#+/)[0].length); output.push(`<h${level}>${inlineMarkdown(line.replace(/^#+\s+/, ""))}</h${level}>`); }
      else if (/^>\s?/.test(line)) output.push(`<blockquote class="note-callout">${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      else if (/^(?:---|\*\*\*|___)\s*$/.test(line)) output.push("<hr>");
      else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
    });
    closeList(); return output.join("");
}
function plainTextToHtml(text) {
  const source = text.replace(/\r\n/g, "\n"); const fence = /```([\w+-]*)[^\S\r\n]*\n?([\s\S]*?)```/g;
  let cursor = 0; let match; const output = [];
  while ((match = fence.exec(source))) {
    output.push(proseToHtml(source.slice(cursor, match.index)));
    const language = normaliseLanguage(match[1]);
    output.push(`<pre data-language="${language}"><code data-language="${language}">${escapeHtml(match[2].replace(/\n$/, ""))}</code></pre>`);
    cursor = fence.lastIndex;
  }
  output.push(proseToHtml(source.slice(cursor))); return output.join("");
}
function looksLikeMarkdown(text) {
  return /^\s*(?:#{1,4}\s+|[-*•]\s+|\d+[.)]\s*|>\s?|```|(?:---|\*\*\*|___)\s*$)/m.test(text)
    || /\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\//.test(text);
}
function markdownFromSimpleHtml(html) {
  const copy = new DOMParser().parseFromString(html, "text/html");
  if (![...copy.body.querySelectorAll("*")].every((node) => ["DIV", "P", "BR"].includes(node.tagName))) return "";
  const withBreaks = copy.body.innerHTML.replace(/<br\s*\/?>(?:\n)?/gi, "\n").replace(/<\/(?:div|p)>/gi, "\n").replace(/<(?:div|p)[^>]*>/gi, "");
  const text = new DOMParser().parseFromString(withBreaks, "text/html").body.textContent.replace(/\n{3,}/g, "\n\n").trim();
  return looksLikeMarkdown(text) ? text : "";
}
function detectLanguage(source) {
  if (/^\s*</.test(source) && /<\/?[a-z][^>]*>/i.test(source)) return "html";
  if (/^\s*[\[{]/.test(source) && /"[^"\n]+"\s*:/.test(source)) return "json";
  if (/^\s*(?:SELECT|INSERT|UPDATE|CREATE|DELETE)\b/im.test(source)) return "sql";
  if (/^\s*(?:def |import |from |print\()/m.test(source)) return "python";
  if (/^\s*(?:#\!\/bin|echo |export |npm |git )/m.test(source)) return "bash";
  if (/\b(?:const|let|var|function|class|import|export|=>)\b/.test(source)) return "javascript";
  if (/\{[^}]*:[^}]*;/.test(source)) return "css";
  return "text";
}
function highlightSource(source, language) {
  const keywords = {
    javascript: /\b(?:const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|throw|try|catch|true|false|null|undefined)\b/g,
    typescript: /\b(?:const|let|var|function|return|if|else|for|while|class|interface|type|import|from|export|async|await|public|private|true|false|null|undefined)\b/g,
    python: /\b(?:def|return|if|elif|else|for|while|in|import|from|as|class|try|except|with|True|False|None|lambda)\b/g,
    sql: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|DELETE|CREATE|TABLE|JOIN|ON|ORDER|BY|GROUP|AS|AND|OR|NULL)\b/gi,
    css: /\b(?:display|color|background|margin|padding|border|font|grid|flex|position|width|height)\b/g,
    bash: /\b(?:if|then|fi|for|do|done|in|case|esac|export|function)\b/g
  };
  const patterns = {
    html: /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi,
    json: /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
    css: /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[0-9a-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|deg)?\b|\b(?:display|color|background|margin|padding|border|font|grid|flex|position|width|height)\b/g,
    default: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b/g
  };
  const pattern = patterns[language] || patterns.default; const keyword = keywords[language]; let cursor = 0; let html = "";
  source.replace(pattern, (match, offset) => {
    const before = source.slice(cursor, offset);
    html += keyword ? before.replace(keyword, (word) => `<span class="token-keyword">${escapeHtml(word)}</span>`) : escapeHtml(before);
    const token = /^\/\*|^\/\/|^#/.test(match) ? "comment" : /^['"`]/.test(match) ? (language === "json" && /:\s*$/.test(source.slice(offset + match.length)) ? "property" : "string") : /^</.test(match) ? "tag" : "number";
    html += `<span class="token-${token}">${escapeHtml(match)}</span>`; cursor = offset + match.length; return match;
  });
  const tail = source.slice(cursor); return html + (keyword ? tail.replace(keyword, (word) => `<span class="token-keyword">${escapeHtml(word)}</span>`) : escapeHtml(tail));
}
function formatCodeBlocks(root) {
  root.querySelectorAll("pre code").forEach((code) => {
    const source = code.textContent; const language = normaliseLanguage(code.dataset.language || code.parentElement.dataset.language || detectLanguage(source));
    code.dataset.language = language; code.parentElement.dataset.language = language; code.innerHTML = highlightSource(source, language);
  });
}

// --- Atelier Markdown : un brouillon local, volontairement indépendant de Supabase. ---
function readMarkdownDraft() {
  try { return JSON.parse(localStorage.getItem(MARKDOWN_DRAFT_KEY)) || { title: "", content: "" }; }
  catch { return { title: "", content: "" }; }
}
function renderMarkdownPreview() {
  const content = $("#markdown-content").value;
  const preview = $("#markdown-preview"); preview.innerHTML = plainTextToHtml(content); preview.dataset.empty = String(!content.trim());
  formatCodeBlocks(preview);
}
function saveMarkdownDraftSoon() {
  renderMarkdownPreview(); clearTimeout(markdownTimer); $("#markdown-save-state").textContent = "Enregistrement local…";
  markdownTimer = setTimeout(() => {
    try {
      localStorage.setItem(MARKDOWN_DRAFT_KEY, JSON.stringify({ title: $("#markdown-note-title").value.slice(0, 160), content: $("#markdown-content").value }));
      $("#markdown-save-state").textContent = "Brouillon enregistré sur cet appareil";
    } catch { $("#markdown-save-state").textContent = "Impossible d’enregistrer le brouillon local"; }
  }, 250);
}
function renderMarkdownWorkspace() {
  const draft = readMarkdownDraft(); $("#markdown-note-title").value = draft.title || ""; $("#markdown-content").value = draft.content || "";
  renderMarkdownPreview(); setMarkdownPreviewVisible(false);
}
function setMarkdownPreviewVisible(visible) {
  markdownPreviewVisible = visible; const workspace = $("#markdown-workspace"); const toggle = $("#markdown-view-toggle");
  workspace.classList.toggle("show-preview", visible); toggle.textContent = visible ? "Écrire" : "Aperçu"; toggle.setAttribute("aria-pressed", String(visible));
}
function replaceMarkdownSelection(before, after, fallback) {
  const area = $("#markdown-content"); const start = area.selectionStart; const end = area.selectionEnd; const selected = area.value.slice(start, end) || fallback;
  area.setRangeText(`${before}${selected}${after}`, start, end, "end"); area.focus(); saveMarkdownDraftSoon();
}
function insertMarkdown(action) {
  const area = $("#markdown-content"); const start = area.selectionStart; const end = area.selectionEnd; const selected = area.value.slice(start, end);
  if (action === "heading") return replaceMarkdownSelection("# ", "", "Un titre");
  if (action === "bold") return replaceMarkdownSelection("**", "**", "mot important");
  if (action === "link") return replaceMarkdownSelection("[", "](https://example.com)", "texte du lien");
  if (action === "code") return replaceMarkdownSelection("```javascript\n", "\n```", "// votre code");
  const linePrefix = action === "bullets" ? "- " : action === "steps" ? "1. " : "> ";
  const text = selected || (action === "bullets" ? "un élément" : action === "steps" ? "une étape" : "une citation");
  const value = text.split("\n").map((line, index) => action === "steps" ? `${index + 1}. ${line}` : `${linePrefix}${line}`).join("\n");
  area.setRangeText(value, start, end, "end"); area.focus(); saveMarkdownDraftSoon();
}
function normaliseNoteContent(content) {
  const value = String(content || "");
  if (!/<\/?[a-z][\s\S]*>/i.test(value)) return plainTextToHtml(value);
  const markdown = markdownFromSimpleHtml(value);
  return markdown ? plainTextToHtml(markdown) : sanitizeNoteHtml(value);
}
function notePreview(content) {
  const temporary = document.createElement("div"); temporary.innerHTML = normaliseNoteContent(content);
  return temporary.textContent.trim() || "Note vide";
}

// --- Rendu. Les contenus riches sont assainis avant d'entrer dans le DOM. ---
function renderTasks() {
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  const archivedTasks = tasks.filter((task) => task.archivedAt);
  const shownTasks = taskArchiveView ? archivedTasks : tasks.filter((task) => !task.archivedAt);
  $("#show-task-archives").textContent = taskArchiveView ? "✓" : "▤";
  $("#show-task-archives").setAttribute("aria-pressed", String(taskArchiveView));
  $("#show-task-archives").setAttribute("aria-label", taskArchiveView ? "Revenir aux tâches actives" : `Consulter les archives de tâches (${archivedTasks.length})`);
  $("#show-task-archives").title = taskArchiveView ? "Revenir aux tâches actives" : `Consulter les archives de tâches (${archivedTasks.length})`;
  const list = $("#task-list"); list.replaceChildren(); $("#tasks-empty").hidden = shownTasks.length > 0;
  $("#tasks-empty").textContent = taskArchiveView ? "Aucune tâche archivée." : "Aucune tâche. À l’aventure !";
  const byId = new Map(shownTasks.map((task) => [task.id, task]));
  const childrenOf = (parentId) => shownTasks.filter((task) => (task.parentId || null) === parentId);
  const appendTask = (task, depth, ancestry) => {
    if (ancestry.has(task.id)) return; // Évite d'afficher une boucle éventuellement ancienne.
    const item = document.createElement("li"); item.className = `task${task.done ? " done" : ""}${task.archivedAt ? " archived" : ""}`;
    const visualDepth = Math.min(depth, 4); item.dataset.depth = String(visualDepth); item.dataset.taskId = task.id; item.style.marginLeft = `${visualDepth * 14}px`; item.style.width = `calc(100% - ${visualDepth * 14}px)`;
    item.draggable = !taskArchiveView; item.setAttribute("aria-roledescription", taskArchiveView ? "Tâche archivée" : "Tâche déplaçable"); item.title = taskArchiveView ? "Archive de tâche" : "Glissez cette tâche sur une autre pour en faire une sous-tâche";
    item.ondragstart = (event) => { draggedTaskId = task.id; item.classList.add("dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); };
    item.ondragend = () => { draggedTaskId = null; document.querySelectorAll(".task.drop-target").forEach((target) => target.classList.remove("drop-target")); item.classList.remove("dragging"); };
    item.ondragover = (event) => { if (!canNestTask(draggedTaskId, task.id)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; item.classList.add("drop-target"); };
    item.ondragleave = () => item.classList.remove("drop-target");
    item.ondrop = async (event) => { event.preventDefault(); item.classList.remove("drop-target"); const childId = event.dataTransfer.getData("text/plain") || draggedTaskId; if (canNestTask(childId, task.id)) await moveTaskToParent(childId, task.id); };
    if (!taskArchiveView) wireTouchNesting(item, task.id);
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = task.done;
    check.disabled = taskArchiveView;
    check.onchange = async () => { task.done = check.checked; await change("tasks", task); renderTasks(); };
    const grip = document.createElement("span"); grip.className = "task-grip"; grip.setAttribute("aria-hidden", "true"); grip.textContent = "⠿";
    const text = document.createElement("span"); text.textContent = task.text;
    if (!taskArchiveView) {
      const child = document.createElement("button"); child.className = "task-child"; child.type = "button"; child.textContent = "+"; child.title = "Créer une sous-tâche"; child.setAttribute("aria-label", `Créer une sous-tâche de ${task.text}`); child.onclick = () => createChildTask(task.id);
      const edit = document.createElement("button"); edit.className = "task-edit"; edit.type = "button"; edit.textContent = "✎"; edit.title = "Modifier la tâche"; edit.setAttribute("aria-label", `Modifier ${task.text}`); edit.onclick = () => editTask(task, text);
      const archive = document.createElement("button"); archive.className = "delete"; archive.type = "button"; archive.textContent = "×"; archive.title = "Archiver cette tâche"; archive.setAttribute("aria-label", "Archiver cette tâche"); archive.onclick = () => archiveTask(task.id);
      item.append(check, grip, text, child, edit, archive);
    } else {
      const restore = document.createElement("button"); restore.className = "task-restore"; restore.type = "button"; restore.textContent = "↶"; restore.title = "Restaurer cette tâche"; restore.setAttribute("aria-label", "Restaurer cette tâche"); restore.onclick = () => restoreTask(task.id);
      item.append(check, grip, text, restore);
    }
    list.append(item);
    const nextAncestry = new Set(ancestry); nextAncestry.add(task.id); childrenOf(task.id).forEach((nested) => appendTask(nested, depth + 1, nextAncestry));
  };
  shownTasks.filter((task) => !task.parentId || !byId.has(task.parentId)).forEach((task) => appendTask(task, 0, new Set()));
}
function clearTouchNesting() {
  clearTimeout(touchNestTimer); touchNestTimer = null;
  document.querySelectorAll(".task.touch-nesting, .task.touch-drop-target").forEach((element) => element.classList.remove("touch-nesting", "touch-drop-target"));
  touchDraggedTaskId = null; touchDropTarget = null;
}
function touchTaskAt(touch) {
  const element = document.elementFromPoint(touch.clientX, touch.clientY);
  return element?.closest(".task") || null;
}
function wireTouchNesting(item, taskId) {
  let startPoint = null;
  item.addEventListener("touchstart", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, input, .task-edit-field")) return;
    const touch = event.touches[0]; if (!touch) return;
    startPoint = { x: touch.clientX, y: touch.clientY };
    touchNestTimer = setTimeout(() => {
      touchDraggedTaskId = taskId; item.classList.add("touch-nesting");
      navigator.vibrate?.(18);
    }, 480);
  }, { passive: true });
  item.addEventListener("touchmove", (event) => {
    const touch = event.touches[0]; if (!touch) return;
    if (!touchDraggedTaskId) {
      if (startPoint && Math.hypot(touch.clientX - startPoint.x, touch.clientY - startPoint.y) > 12) clearTimeout(touchNestTimer);
      return;
    }
    event.preventDefault();
    const candidate = touchTaskAt(touch);
    if (touchDropTarget && touchDropTarget !== candidate) touchDropTarget.classList.remove("touch-drop-target");
    touchDropTarget = candidate && canNestTask(touchDraggedTaskId, candidate.dataset.taskId) ? candidate : null;
    touchDropTarget?.classList.add("touch-drop-target");
  }, { passive: false });
  item.addEventListener("touchend", async (event) => {
    clearTimeout(touchNestTimer); const touch = event.changedTouches[0]; const childId = touchDraggedTaskId;
    const candidate = touch ? touchTaskAt(touch) : null; const parentId = candidate?.dataset.taskId;
    clearTouchNesting(); if (canNestTask(childId, parentId)) await moveTaskToParent(childId, parentId);
  }, { passive: false });
  item.addEventListener("touchcancel", clearTouchNesting, { passive: true });
}
function editTask(task, textElement) {
  const field = document.createElement("input");
  field.className = "task-edit-field"; field.type = "text"; field.maxLength = 180; field.value = task.text;
  field.setAttribute("aria-label", "Modifier le texte de la tâche"); textElement.replaceWith(field); field.focus(); field.select();
  let completed = false;
  const finish = async (save) => {
    if (completed) return; completed = true;
    const value = field.value.trim();
    if (save && value && value !== task.text) { task.text = value; await change("tasks", task); }
    renderTasks();
  };
  field.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  };
  field.onblur = () => finish(true);
}
function canNestTask(childId, parentId) {
  if (!childId || childId === parentId) return false;
  const byId = new Map(tasks.map((task) => [task.id, task])); let cursor = byId.get(parentId);
  while (cursor) { if (cursor.id === childId) return false; cursor = byId.get(cursor.parentId); }
  return byId.has(childId) && byId.has(parentId);
}
async function moveTaskToParent(childId, parentId) {
  if (!canNestTask(childId, parentId)) return;
  const child = tasks.find((task) => task.id === childId); if (child.parentId === parentId) return;
  child.parentId = parentId; await change("tasks", child); renderTasks();
}
async function archiveTask(id) {
  const task = tasks.find((item) => item.id === id); if (!task || task.archivedAt) return;
  task.archivedAt = Date.now(); await change("tasks", task); renderTasks();
}
async function restoreTask(id) {
  const task = tasks.find((item) => item.id === id); if (!task || !task.archivedAt) return;
  task.archivedAt = null; await change("tasks", task); renderTasks();
}
async function archiveCompletedTasks() {
  const completed = tasks.filter((task) => task.done && !task.archivedAt);
  if (!completed.length) return 0;
  const stamp = Date.now(); completed.forEach((task) => { task.archivedAt = stamp; });
  await Promise.all(completed.map((task) => change("tasks", task))); renderTasks(); return completed.length;
}
async function purgeExpiredTaskArchives() {
  const expired = tasks.filter((task) => task.archivedAt && Date.now() - task.archivedAt >= ARCHIVE_RETENTION_MS);
  if (!expired.length) return 0;
  tasks = tasks.filter((task) => !expired.some((old) => old.id === task.id));
  await Promise.all(expired.map((task) => queueDeletion("tasks", task.id))); renderTasks(); sync(); return expired.length;
}
function archiveDayKey(date = new Date()) { return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
async function runDailyTaskArchiveIfDue() {
  const now = new Date(); const key = archiveDayKey(now);
  if (now.getHours() >= 3 && localStorage.getItem("organiseur-last-task-archive") !== key) {
    await archiveCompletedTasks(); localStorage.setItem("organiseur-last-task-archive", key);
  }
  await purgeExpiredTaskArchives();
}
function scheduleDailyTaskArchive() {
  clearTimeout(dailyArchiveTimer); const now = new Date(); const next = new Date(now);
  next.setHours(3, 0, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
  dailyArchiveTimer = setTimeout(async () => { await runDailyTaskArchiveIfDue(); scheduleDailyTaskArchive(); }, next - now + 80);
}
function renderNotes() {
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  const query = noteSearch.trim().toLocaleLowerCase("fr-FR");
  const archivedNotes = notes.filter((note) => note.archivedAt);
  $("#show-note-archives").textContent = noteArchiveView ? "✓" : "▤";
  $("#show-note-archives").setAttribute("aria-pressed", String(noteArchiveView));
  $("#show-note-archives").setAttribute("aria-label", noteArchiveView ? "Revenir aux notes actives" : `Consulter les archives de notes (${archivedNotes.length})`);
  $("#show-note-archives").title = noteArchiveView ? "Revenir aux notes actives" : `Consulter les archives de notes (${archivedNotes.length})`;
  // Hors archive, une recherche conserve son rôle de filet de sécurité et retrouve aussi les notes classées.
  const directMatches = notes.filter((note) => {
    const matches = !query || `${note.title} ${notePreview(note.content)}`.toLocaleLowerCase("fr-FR").includes(query);
    return noteArchiveView ? !!note.archivedAt && matches : query ? matches : !note.archivedAt;
  });
  const byId = new Map(notes.map((note) => [note.id, note])); const visibleIds = new Set(directMatches.map((note) => note.id));
  // Une recherche garde les parents visibles : le contexte de chaque sous-note reste clair.
  directMatches.forEach((note) => { let parent = byId.get(note.parentId); while (parent && !visibleIds.has(parent.id)) { visibleIds.add(parent.id); parent = byId.get(parent.parentId); } });
  const list = $("#notes-list"); list.replaceChildren(); $("#notes-empty").hidden = directMatches.length > 0;
  $("#notes-empty").textContent = noteArchiveView ? "Aucune note archivée." : notes.length && query ? "Aucune note ne contient cette recherche." : "Aucune note.";
  const childrenOf = (parentId) => notes.filter((note) => (note.parentId || null) === parentId && (!query || visibleIds.has(note.id)));
  const appendNote = (note, depth, ancestry) => {
    if (ancestry.has(note.id)) return; // Protection contre une éventuelle boucle ancienne.
    const card = document.createElement("article"); card.className = `note-card${note.id === selectedNoteId ? " selected" : ""}${note.archivedAt ? " archived" : ""}`;
    const visualDepth = Math.min(depth, 4); card.dataset.depth = String(visualDepth); card.style.marginLeft = `${visualDepth * 14}px`; card.style.width = `calc(100% - ${visualDepth * 14}px)`;
    card.draggable = !note.archivedAt; card.setAttribute("aria-roledescription", note.archivedAt ? "Note archivée" : "Note déplaçable"); card.title = note.archivedAt ? "Note archivée" : "Glissez cette note sur une autre pour en faire une sous-note";
    card.ondragstart = (event) => { draggedNoteId = note.id; card.classList.add("dragging"); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", note.id); };
    card.ondragend = () => { draggedNoteId = null; document.querySelectorAll(".note-card.drop-target").forEach((target) => target.classList.remove("drop-target")); card.classList.remove("dragging"); };
    card.ondragover = (event) => { if (!canNestNote(draggedNoteId, note.id)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; card.classList.add("drop-target"); };
    card.ondragleave = () => card.classList.remove("drop-target");
    card.ondrop = async (event) => { event.preventDefault(); card.classList.remove("drop-target"); const childId = event.dataTransfer.getData("text/plain") || draggedNoteId; if (canNestNote(childId, note.id)) await moveNoteToParent(childId, note.id); };
    const grip = document.createElement("span"); grip.className = "note-grip"; grip.setAttribute("aria-hidden", "true"); grip.textContent = "⠿";
    const open = document.createElement("button"); open.className = "note-open"; open.type = "button"; open.setAttribute("aria-label", `Ouvrir ${note.title || "la note"}`);
    const title = document.createElement("strong"); title.textContent = note.title || "Sans titre";
    const preview = document.createElement("span"); preview.textContent = notePreview(note.content);
    open.append(title, preview); open.onclick = () => { selectedNoteId = note.id; renderNotes(); };
    const archive = document.createElement("button"); archive.className = "note-archive"; archive.type = "button"; archive.textContent = note.archivedAt ? "↶" : "▣"; archive.title = note.archivedAt ? "Restaurer cette note" : "Archiver cette note";
    archive.setAttribute("aria-label", archive.title); archive.onclick = () => toggleNoteArchive(note.id);
    const remove = document.createElement("button"); remove.className = "delete note-delete"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "Supprimer cette note");
    remove.onclick = () => deleteNote(note.id);
    if (!note.archivedAt) { const child = document.createElement("button"); child.className = "note-child"; child.type = "button"; child.textContent = "+"; child.title = "Créer une sous-note"; child.setAttribute("aria-label", `Créer une sous-note de ${note.title || "cette note"}`); child.onclick = () => createChildNote(note.id); card.append(grip, open, child, archive, remove); }
    else card.append(grip, open, archive, remove);
    list.append(card);
    const nextAncestry = new Set(ancestry); nextAncestry.add(note.id); childrenOf(note.id).forEach((nested) => appendNote(nested, depth + 1, nextAncestry));
  };
  const roots = notes.filter((note) => !note.parentId || !visibleIds.has(note.parentId)).filter((note) => visibleIds.has(note.id));
  roots.forEach((note) => appendNote(note, 0, new Set()));
  const note = notes.find((item) => item.id === selectedNoteId); const opened = !!note;
  ["#note-title", "#note-content", "#note-sync", "#read-note"].forEach((id) => $(id).classList.toggle("hidden", !opened));
  $("#editor-empty").hidden = opened;
  const preserveEditor = document.activeElement === $("#note-title") || document.activeElement === $("#note-content");
  if (opened && !preserveEditor) {
    $("#note-title").value = note.title;
    $("#note-content").innerHTML = normaliseNoteContent(note.content);
    formatCodeBlocks($("#note-content"));
  }
}
function canNestNote(childId, parentId) {
  if (!childId || childId === parentId) return false;
  const byId = new Map(notes.map((note) => [note.id, note])); let cursor = byId.get(parentId);
  while (cursor) { if (cursor.id === childId) return false; cursor = byId.get(cursor.parentId); }
  return byId.has(childId) && byId.has(parentId);
}
async function moveNoteToParent(childId, parentId) {
  if (!canNestNote(childId, parentId)) return;
  const child = notes.find((note) => note.id === childId); if (child.parentId === parentId) return;
  child.parentId = parentId; await change("notes", child); renderNotes();
}
async function toggleNoteArchive(id) {
  const note = notes.find((item) => item.id === id); if (!note) return;
  note.archivedAt = note.archivedAt ? null : Date.now();
  if (note.archivedAt && selectedNoteId === id && !noteSearch.trim()) selectedNoteId = null;
  await change("notes", note); renderNotes();
}
function renderCalendar() {
  const today = new Date();
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const grid = $("#calendar-grid");
  const firstOfMonth = new Date(year, month, 1);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);

  $("#calendar-month").textContent = MONTHS[month];
  $("#calendar-year").textContent = year;
  $("#calendar-full-date").textContent = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(today);
  grid.replaceChildren();

  // Six rangées, comme un calendrier de bureau. La première colonne est le n° de semaine ISO.
  for (let week = 0; week < 6; week += 1) {
    const monday = new Date(gridStart);
    monday.setDate(gridStart.getDate() + week * 7);
    const currentMonday = new Date(today);
    currentMonday.setHours(0, 0, 0, 0);
    currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const row = document.createElement("div");
    row.className = `calendar-week-row${monday.toDateString() === currentMonday.toDateString() ? " current-week" : ""}`;
    grid.append(row);
    const weekCell = document.createElement("span");
    weekCell.className = "calendar-week";
    weekCell.textContent = isoWeekNumber(monday);
    weekCell.setAttribute("aria-label", `Semaine ${weekCell.textContent}`);
    row.append(weekCell);

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + weekday);
      const isCurrentMonth = date.getMonth() === month;
      const cell = document.createElement("time");

      if (!isCurrentMonth) {
        cell.className = "calendar-empty";
        cell.setAttribute("aria-hidden", "true");
        row.append(cell);
        continue;
      }

      const isToday = date.toDateString() === today.toDateString();
      const weekendClass = weekday === 5 ? " saturday" : weekday === 6 ? " sunday" : "";
      cell.className = `calendar-day${isToday ? " today" : ""}${weekendClass}`;
      cell.textContent = date.getDate();
      cell.dateTime = `${year}-${String(month + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (isToday) cell.setAttribute("aria-label", `Aujourd’hui, le ${date.getDate()} ${MONTHS[month].toLowerCase()} ${year}`);
      row.append(cell);
    }
  }
}

function moveCalendar(monthOffset) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + monthOffset, 1);
  renderCalendar();
}

function returnToCurrentMonth() {
  const now = new Date();
  calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  renderCalendar();
}
function isoWeekNumber(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return Math.ceil(((copy - yearStart) / 86400000 + 1) / 7);
}

// --- Connexion : une transmission chiffrée à reconstituer, même hors ligne. ---
function makeCipher() {
  const symbols = ["✦", "◈", "⌁", "⌘"];
  cipher = Array.from({ length: 3 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
}
function updateGameStats(message) {
  $("#wait-score").textContent = bubbleScore;
  $("#code-sequence").textContent = cipher.join(" · ");
  $("#mission-count").textContent = completedMissions;
  if (message) $("#wait-game-message").textContent = message;
}
function grantArchiveReward() {
  const reward = ARCHIVE_REWARDS[(completedMissions - 1) % ARCHIVE_REWARDS.length];
  const output = $("#mission-reward");
  output.textContent = `★ Archive ${completedMissions} déverrouillée : ${reward}`;
  output.hidden = false;
}
function addBubble() {
  const field = $("#bubble-field");
  if (field.children.length >= 6) field.firstElementChild.remove();
  const bubble = document.createElement("button");
  const clues = ["✦", "⌁", "◈", "⌘"];
  const mustOfferExpected = bubbleSerial % 3 === 0;
  bubbleSerial += 1;
  const alert = !mustOfferExpected && Math.random() < .18;
  const symbol = alert ? "!" : mustOfferExpected ? cipher[bubbleScore] : clues[Math.floor(Math.random() * clues.length)];
  bubble.type = "button"; bubble.className = `comic-bubble${alert ? " alert" : ""}`; bubble.textContent = symbol;
  bubble.style.left = `${5 + Math.random() * 80}%`;
  bubble.setAttribute("aria-label", alert ? "Alerte à éviter" : `Indice ${symbol}`);
  bubble.onclick = () => {
    if (alert) {
      bubbleScore = 0;
      updateGameStats("Alerte ! La transmission doit être recommencée.");
    } else if (symbol === cipher[bubbleScore]) {
      bubbleScore += 1;
      if (bubbleScore === cipher.length) {
        completedMissions += 1; bubbleScore = 0; makeCipher();
        grantArchiveReward();
        updateGameStats("Transmission décodée ! Votre archive est déverrouillée.");
      } else updateGameStats("Bon fragment : poursuivez la transmission.");
    } else {
      bubbleScore = 0;
      updateGameStats("Mauvais fragment : le code est brouillé.");
    }
    bubble.remove();
  };
  field.append(bubble);
  setTimeout(() => bubble.remove(), 3150);
}
function startWaitGame() {
  if (bubbleTimer) return;
  bubbleScore = 0; bubbleSerial = 0; makeCipher();
  updateGameStats();
  addBubble(); bubbleTimer = setInterval(addBubble, 650);
}
function pauseWaitGame() {
  clearInterval(bubbleTimer); bubbleTimer = null;
  $("#bubble-field").replaceChildren();
}
function updateEmailCooldown() {
  const until = Number(localStorage.getItem(EMAIL_COOLDOWN_KEY) || 0);
  const remaining = Math.ceil((until - Date.now()) / 1000);
  const submit = $("#login-submit");
  if (remaining <= 0) {
    clearInterval(emailCooldownTimer); emailCooldownTimer = null;
    localStorage.removeItem(EMAIL_COOLDOWN_KEY); submit.disabled = false; submit.textContent = "Recevoir mon lien";
    return;
  }
  submit.disabled = true; submit.textContent = `Réessayer dans ${remaining} s`;
  $("#login-message").textContent = `Patientez ${remaining} seconde${remaining > 1 ? "s" : ""} avant une nouvelle demande.`;
}
function startEmailCooldown() {
  localStorage.setItem(EMAIL_COOLDOWN_KEY, String(Date.now() + EMAIL_COOLDOWN_MS));
  clearInterval(emailCooldownTimer); updateEmailCooldown();
  emailCooldownTimer = setInterval(updateEmailCooldown, 500);
}

// --- Synchronisation Supabase. ---
async function change(storeName, record) {
  record.updatedAt = Date.now(); await put(storeName, record);
  await put(QUEUE, { id: `${storeName}:${record.id}`, table: storeName === "tasks" ? "todos" : "notes", type: "upsert", record: { ...record } });
  sync();
}
async function queueDeletion(storeName, id) {
  await drop(storeName, id);
  await put(QUEUE, { id: `${storeName}:${id}`, table: storeName === "tasks" ? "todos" : "notes", type: "delete", record: { id } });
}
async function deleteTask(id) {
  // Une sous-tâche n'est jamais perdue : elle redevient simplement une tâche racine.
  const children = tasks.filter((task) => task.parentId === id); children.forEach((task) => { task.parentId = null; });
  tasks = tasks.filter((task) => task.id !== id);
  await Promise.all(children.map((task) => change("tasks", task))); await queueDeletion("tasks", id); renderTasks(); sync();
}
async function deleteNote(id) {
  const children = notes.filter((note) => note.parentId === id); children.forEach((note) => { note.parentId = null; });
  notes = notes.filter((note) => note.id !== id); if (selectedNoteId === id) selectedNoteId = notes[0]?.id || null;
  await Promise.all(children.map((note) => change("notes", note))); await queueDeletion("notes", id); renderNotes(); sync();
}
function encodeMeta(meta) { return encodeURIComponent(JSON.stringify(meta)); }
function decodeMeta(value) { try { return JSON.parse(decodeURIComponent(value)); } catch { return {}; } }
function packedNoteContent(note) {
  const meta = {}; if (note.parentId) meta.parentId = note.parentId; if (note.archivedAt) meta.archivedAt = note.archivedAt;
  return Object.keys(meta).length ? `<!--organiseur-note-meta:${encodeMeta(meta)}-->${note.content || ""}` : note.content || "";
}
function unpackedNote(row) {
  let source = String(row.content || ""); const metaMatch = source.match(NOTE_META_MARKER); const meta = metaMatch ? decodeMeta(metaMatch[1]) : {};
  if (metaMatch) source = source.slice(metaMatch[0].length);
  const legacy = source.match(NOTE_PARENT_MARKER); if (legacy) source = source.slice(legacy[0].length);
  return { content: source, parentId: meta.parentId || legacy?.[1] || null, archivedAt: Number(meta.archivedAt) || null };
}
// Le parent est rangé dans le champ texte déjà présent dans Supabase : aucune migration n'est nécessaire.
function packedTaskText(task) {
  const meta = {}; if (task.parentId) meta.parentId = task.parentId; if (task.archivedAt) meta.archivedAt = task.archivedAt;
  return Object.keys(meta).length ? `<!--organiseur-task-meta:${encodeMeta(meta)}-->${task.text || ""}` : task.text || "";
}
function unpackedTask(row) {
  let source = String(row.text || ""); const metaMatch = source.match(TASK_META_MARKER); const meta = metaMatch ? decodeMeta(metaMatch[1]) : {};
  if (metaMatch) source = source.slice(metaMatch[0].length);
  const legacy = source.match(TASK_PARENT_MARKER); if (legacy) source = source.slice(legacy[0].length);
  return { text: source, parentId: meta.parentId || legacy?.[1] || null, archivedAt: Number(meta.archivedAt) || null };
}
async function flush() {
  if (!user || !navigator.onLine) return;
  for (const operation of await all(QUEUE)) {
    const request = operation.type === "delete"
      ? sbClient.from(operation.table).delete().eq("id", operation.record.id)
      : sbClient.from(operation.table).upsert({ id: operation.record.id, user_id: user.id, text: operation.table === "todos" ? packedTaskText(operation.record) : operation.record.text, title: operation.record.title, content: operation.table === "notes" ? packedNoteContent(operation.record) : operation.record.content, done: operation.record.done, created_at: new Date(operation.record.createdAt).toISOString(), updated_at: new Date(operation.record.updatedAt).toISOString() });
    const { error } = await request; if (error) throw error; await drop(QUEUE, operation.id);
  }
}
async function pull(table) {
  const { data, error } = await sbClient.from(table).select("*").order("updated_at", { ascending: false }); if (error) throw error;
  const remoteRecords = data.map((row) => table === "todos" ? ({ id: row.id, ...unpackedTask(row), done: row.done, createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at) }) : ({ id: row.id, title: row.title, ...unpackedNote(row), createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at) }));
  const storeName = table === "todos" ? "tasks" : "notes";
  const localRecords = table === "todos" ? tasks : notes;
  const pending = await all(QUEUE);
  const pendingIds = new Set(pending.filter((operation) => operation.table === table && operation.type === "upsert").map((operation) => operation.record.id));
  const deletedIds = new Set(pending.filter((operation) => operation.table === table && operation.type === "delete").map((operation) => operation.record.id));
  const localById = new Map(localRecords.map((record) => [record.id, record]));
  const merged = remoteRecords.filter((record) => !deletedIds.has(record.id)).map((remote) => {
    const local = localById.get(remote.id);
    return local && (pendingIds.has(local.id) || local.updatedAt > remote.updatedAt) ? local : remote;
  });
  localRecords.forEach((local) => { if (pendingIds.has(local.id) && !merged.some((record) => record.id === local.id)) merged.push(local); });
  if (table === "todos") { tasks = merged; await Promise.all(tasks.map((x) => put("tasks", x))); renderTasks(); }
  else { notes = merged; if (!notes.some((x) => x.id === selectedNoteId)) selectedNoteId = notes[0]?.id || null; await Promise.all(notes.map((x) => put("notes", x))); renderNotes(); }
}
async function syncOnce() {
  if (!configured || !user) return;
  try { status(navigator.onLine ? "Synchronisation" : "Hors ligne"); await flush(); await pull("todos"); await pull("notes"); account(user); }
  catch (error) { console.error(error); status("Hors ligne"); }
}
function sync() {
  if (!configured || !user) return Promise.resolve();
  syncRequested = true;
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    while (syncRequested) { syncRequested = false; await syncOnce(); }
  })().finally(() => { syncInFlight = null; });
  return syncInFlight;
}
async function subscribe() {
  if (todoChannel) await sbClient.removeChannel(todoChannel); if (noteChannel) await sbClient.removeChannel(noteChannel);
  const options = { event: "*", schema: "public", filter: `user_id=eq.${user.id}` };
  // Les événements temps réel rejoignent la file unique : aucune relecture ne peut écraser une édition en cours.
  todoChannel = sbClient.channel(`todos:${user.id}`).on("postgres_changes", { ...options, table: "todos" }, () => sync()).subscribe();
  noteChannel = sbClient.channel(`notes:${user.id}`).on("postgres_changes", { ...options, table: "notes" }, () => sync()).subscribe();
}

// --- Événements utilisateur. ---
async function createChildTask(parentId) {
  const now = Date.now();
  const task = { id: crypto.randomUUID(), parentId, text: "Nouvelle sous-tâche", done: false, createdAt: now, updatedAt: now };
  tasks.unshift(task); await change("tasks", task); renderTasks();
}
$("#task-form").onsubmit = async (event) => { event.preventDefault(); const input = $("#task-input"), text = input.value.trim(); if (!text) return; const now = Date.now(), task = { id: crypto.randomUUID(), parentId: null, text, done: false, createdAt: now, updatedAt: now }; tasks.unshift(task); await change("tasks", task); input.value = ""; renderTasks(); };
$("#clear-done").onclick = async () => { const count = await archiveCompletedTasks(); $("#maintenance-message").textContent = count ? `${count} tâche${count > 1 ? "s" : ""} terminée${count > 1 ? "s" : ""} archivée${count > 1 ? "s" : ""}.` : "Aucune tâche terminée à archiver."; };
function datedNoteTitle() {
  const stamp = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
  return `Note — ${stamp}`;
}
async function createChildNote(parentId) {
  const now = Date.now(); const note = { id: crypto.randomUUID(), parentId, title: datedNoteTitle(), content: "", createdAt: now, updatedAt: now };
  notes.unshift(note); selectedNoteId = note.id; await change("notes", note); renderNotes(); $("#note-title").focus(); $("#note-title").select();
}
$("#new-note").onclick = async () => { const now = Date.now(), note = { id: crypto.randomUUID(), parentId: null, title: datedNoteTitle(), content: "", createdAt: now, updatedAt: now }; notes.unshift(note); selectedNoteId = note.id; await change("notes", note); renderNotes(); $("#note-title").focus(); $("#note-title").select(); };
function insertHtmlAtCursor(html) {
  const selection = window.getSelection(); if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0); range.deleteContents();
  const fragment = range.createContextualFragment(html); const lastNode = fragment.lastChild;
  range.insertNode(fragment); if (lastNode) { range.setStartAfter(lastNode); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
}
function saveNoteSoon() {
  const note = notes.find((item) => item.id === selectedNoteId); if (!note) return;
  note.title = $("#note-title").value.trim().slice(0, 160) || datedNoteTitle(); note.content = normaliseNoteContent($("#note-content").innerHTML);
  clearTimeout(noteTimer); noteTimer = setTimeout(async () => { await change("notes", note); renderNotes(); }, 450);
}
$("#note-title").oninput = saveNoteSoon; $("#note-content").oninput = saveNoteSoon;
$("#note-title").onblur = () => { if (!$("#note-title").value.trim()) { $("#note-title").value = datedNoteTitle(); saveNoteSoon(); } };
$("#note-content").onblur = () => { const content = normaliseNoteContent($("#note-content").innerHTML); $("#note-content").innerHTML = content; formatCodeBlocks($("#note-content")); saveNoteSoon(); };
$("#note-content").onpaste = (event) => {
  event.preventDefault(); const clipboard = event.clipboardData;
  const html = clipboard.getData("text/html"); const text = clipboard.getData("text/plain");
  insertHtmlAtCursor(html ? sanitizeNoteHtml(html) : plainTextToHtml(text));
  formatCodeBlocks($("#note-content")); saveNoteSoon();
};
function openReader() {
  const note = notes.find((item) => item.id === selectedNoteId); if (!note) return;
  note.title = $("#note-title").value.slice(0, 160); note.content = normaliseNoteContent($("#note-content").innerHTML);
  $("#reader-title").textContent = note.title || "Sans titre";
  $("#reader-content").innerHTML = normaliseNoteContent(note.content);
  formatCodeBlocks($("#reader-content"));
  $("#note-reader").classList.remove("hidden"); document.body.classList.add("reading-note"); $("#close-reader").focus();
}
function saveReaderSoon() {
  const note = notes.find((item) => item.id === selectedNoteId); if (!note) return;
  note.content = normaliseNoteContent($("#reader-content").innerHTML); clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => { await change("notes", note); $("#note-content").innerHTML = normaliseNoteContent(note.content); formatCodeBlocks($("#note-content")); renderNotes(); }, 450);
}
function closeReader() { saveReaderSoon(); $("#note-reader").classList.add("hidden"); document.body.classList.remove("reading-note"); $("#read-note").focus(); }
$("#read-note").onclick = openReader; $("#close-reader").onclick = closeReader;
$("#reader-content").oninput = saveReaderSoon;
$("#reader-content").onblur = () => { $("#reader-content").innerHTML = normaliseNoteContent($("#reader-content").innerHTML); formatCodeBlocks($("#reader-content")); saveReaderSoon(); };
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#note-reader").classList.contains("hidden")) closeReader();
});
async function removeQueuedOperations(table) {
  const operations = await all(QUEUE);
  await Promise.all(operations.filter((operation) => operation.table === table).map((operation) => drop(QUEUE, operation.id)));
}
async function resetRemoteCollection(kind) {
  const isNotes = kind === "notes"; const table = isNotes ? "notes" : "todos"; const storeName = isNotes ? "notes" : "tasks";
  const label = isNotes ? "toutes vos notes" : "toutes vos tâches";
  if (!confirm(`Voulez-vous définitivement effacer ${label}, sur cet appareil et dans Supabase ?`)) return;
  try {
    if (configured && user) { const { error } = await sbClient.from(table).delete().eq("user_id", user.id); if (error) throw error; }
    await Promise.all([clearStore(storeName), removeQueuedOperations(table)]);
    if (isNotes) { notes = []; selectedNoteId = null; renderNotes(); } else { tasks = []; renderTasks(); }
    $("#maintenance-message").textContent = `${isNotes ? "Notes" : "Tâches"} effacées localement et dans Supabase.`;
  } catch (error) { console.error(error); $("#maintenance-message").textContent = "Suppression impossible : vérifiez la connexion Supabase."; status("Erreur"); }
}
async function clearLocalCache() {
  if (!confirm("Vider les copies locales de tâches, notes et du brouillon Markdown ? Les données Supabase ne seront pas supprimées.")) return;
  await Promise.all([clearStore("tasks"), clearStore("notes"), clearStore(QUEUE)]);
  localStorage.removeItem(MARKDOWN_DRAFT_KEY); tasks = []; notes = []; selectedNoteId = null; renderTasks(); renderNotes(); renderMarkdownWorkspace();
  $("#maintenance-message").textContent = user ? "Cache local vidé. Les données Supabase vont être relues." : "Cache local vidé.";
  if (user) sync();
}
function markdownInline(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/([\\`])/g, "\\$1");
  const content = [...node.childNodes].map(markdownInline).join("");
  if (["STRONG", "B"].includes(node.tagName)) return `**${content}**`;
  if (["EM", "I"].includes(node.tagName)) return `*${content}*`;
  if (["DEL", "S"].includes(node.tagName)) return `~~${content}~~`;
  if (node.tagName === "CODE") return `\`${content.replace(/`/g, "\\`")}\``;
  if (node.tagName === "A") return `[${content}](${node.getAttribute("href") || ""})`;
  if (node.tagName === "BR") return "\n";
  return content;
}
function noteToMarkdown(content) {
  const body = new DOMParser().parseFromString(normaliseNoteContent(content), "text/html").body;
  const block = (node) => {
    const text = markdownInline(node).trim();
    if (/^H[1-4]$/.test(node.tagName)) return `${"#".repeat(Number(node.tagName[1]) + 1)} ${text}\n\n`;
    if (["P", "DIV"].includes(node.tagName)) return text ? `${text}\n\n` : "";
    if (["BLOCKQUOTE", "ASIDE"].includes(node.tagName)) return text.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    if (node.tagName === "PRE") { const language = node.dataset.language || node.querySelector("code")?.dataset.language || ""; return `\`\`\`${language}\n${node.textContent.replace(/\n$/, "")}\n\`\`\`\n\n`; }
    if (node.tagName === "UL") return [...node.children].filter((item) => item.tagName === "LI").map((item) => `- ${markdownInline(item).trim()}`).join("\n") + "\n\n";
    if (node.tagName === "OL") return [...node.children].filter((item) => item.tagName === "LI").map((item, index) => `${Number(item.dataset.step) || index + 1}. ${markdownInline(item).trim()}`).join("\n") + "\n\n";
    if (node.tagName === "HR") return "---\n\n";
    return text ? `${text}\n\n` : "";
  };
  return [...body.children].map(block).join("").replace(/\n{3,}/g, "\n\n").trim();
}
function markdownNoteTitle(title) { return String(title || "Sans titre").replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim(); }
function exportNotes() {
  const sections = notes.slice().sort((a, b) => a.createdAt - b.createdAt).map((note) => {
    const parent = /^[a-f0-9-]{36}$/i.test(note.parentId || "") ? note.parentId : "";
    return `<!--organiseur-note id="${note.id}" parent="${parent}" archived-at="${note.archivedAt || ""}"-->\n## ${markdownNoteTitle(note.title)}\n\n${noteToMarkdown(note.content)}\n\n<!--/organiseur-note-->`;
  });
  const source = `# Export des notes — Organiseur MD\n\n${sections.join("\n\n---\n\n")}\n`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/markdown;charset=utf-8" })); const link = document.createElement("a");
  link.href = url; link.download = `organiseur-notes-${new Date().toISOString().slice(0, 10)}.md`; link.click(); URL.revokeObjectURL(url);
  $("#maintenance-message").textContent = `${notes.length} note${notes.length > 1 ? "s" : ""} exportée${notes.length > 1 ? "s" : ""}, archives incluses.`;
}
async function importNotesFile(file) {
  if (!file) return; const source = await file.text();
  const pattern = /<!--organiseur-note\s+id="([a-f0-9-]{36})"\s+parent="([a-f0-9-]*)"\s+archived-at="(\d*)"-->\s*##\s+([^\n]+)\n([\s\S]*?)<!--\/organiseur-note-->/gi;
  const imported = []; let match;
  while ((match = pattern.exec(source))) { const [, id, parentId, archivedAt, title, markdown] = match; imported.push({ id, parentId: parentId || null, archivedAt: Number(archivedAt) || null, title: markdownNoteTitle(title), content: plainTextToHtml(markdown.trim()), createdAt: Date.now(), updatedAt: Date.now() }); }
  if (!imported.length) { $("#maintenance-message").textContent = "Import impossible : choisissez un export Markdown de l’Organiseur MD."; return; }
  const byId = new Map(notes.map((note) => [note.id, note])); imported.forEach((note) => byId.set(note.id, note)); notes = [...byId.values()];
  await Promise.all(imported.map((note) => change("notes", note))); selectedNoteId = imported[0].id; renderNotes();
  $("#maintenance-message").textContent = `${imported.length} note${imported.length > 1 ? "s" : ""} importée${imported.length > 1 ? "s" : ""}.`;
}
async function purgeTaskArchivesManually() {
  const archived = tasks.filter((task) => task.archivedAt);
  if (!archived.length) { $("#maintenance-message").textContent = "Aucune archive de tâche à supprimer."; return; }
  if (!confirm(`Supprimer définitivement ${archived.length} archive${archived.length > 1 ? "s" : ""} de tâche ?`)) return;
  tasks = tasks.filter((task) => !task.archivedAt); await Promise.all(archived.map((task) => queueDeletion("tasks", task.id))); renderTasks(); sync();
  $("#maintenance-message").textContent = "Archives de tâches supprimées définitivement.";
}
$("#reset-notes").onclick = () => resetRemoteCollection("notes");
$("#reset-tasks").onclick = () => resetRemoteCollection("tasks");
$("#show-task-archives").onclick = () => { taskArchiveView = !taskArchiveView; renderTasks(); };
$("#show-note-archives").onclick = () => { noteArchiveView = !noteArchiveView; renderNotes(); };
$("#purge-task-archives").onclick = purgeTaskArchivesManually;
$("#export-notes").onclick = exportNotes;
$("#import-notes").onclick = () => $("#import-notes-file").click();
$("#import-notes-file").onchange = async (event) => { await importNotesFile(event.target.files[0]); event.target.value = ""; };
$("#clear-local").onclick = clearLocalCache;
$("#delete-note").onclick = () => selectedNoteId && deleteNote(selectedNoteId);
$("#notes-search").oninput = () => { noteSearch = $("#notes-search").value; renderNotes(); };
$("#markdown-note-title").oninput = saveMarkdownDraftSoon;
$("#markdown-content").oninput = saveMarkdownDraftSoon;
$("#markdown-view-toggle").onclick = () => setMarkdownPreviewVisible(!markdownPreviewVisible);
document.querySelectorAll("[data-md-action]").forEach((button) => { button.onclick = () => insertMarkdown(button.dataset.mdAction); });
$("#calendar-previous").onclick = () => moveCalendar(-1);
$("#calendar-next").onclick = () => moveCalendar(1);
$("#calendar-today").onclick = returnToCurrentMonth;
$("#login-form").onsubmit = async (event) => {
  event.preventDefault(); const submit = $("#login-submit");
  if (submit.disabled) return;
  if (!sbClient) {
    $("#login-message").textContent = "La connexion Supabase est indisponible. Rechargez la page après avoir vérifié votre connexion Internet.";
    return;
  }
  submit.disabled = true; submit.textContent = "Envoi en cours…";
  $("#login-message").textContent = "Demande du lien sécurisé en cours…";
  try {
    const request = sbClient.auth.signInWithOtp({ email: $("#login-email").value, options: { emailRedirectTo: authRedirectUrl() } });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Délai de connexion dépassé.")), 15_000));
    const { error } = await Promise.race([request, timeout]);
    if (error) {
      const limited = /rate limit|trop de demandes|too many/i.test(error.message);
      $("#login-message").textContent = limited ? "Trop de demandes de lien : une minute d’attente est lancée." : error.message;
      if (limited) startEmailCooldown(); else { submit.disabled = false; submit.textContent = "Recevoir mon lien"; }
      return;
    }
    $("#login-message").textContent = "Lien envoyé : vérifiez vos e-mails puis ouvrez le lien.";
    startEmailCooldown();
  } catch (error) {
    $("#login-message").textContent = error.message === "Délai de connexion dépassé."
      ? "La demande prend trop de temps. Vérifiez Internet puis réessayez."
      : "Impossible de demander le lien pour le moment. Réessayez plus tard.";
    submit.disabled = false; submit.textContent = "Recevoir mon lien";
  }
};
$("#login-email").oninput = () => {
  const input = $("#login-email");
  if (input.validity.valid && input.value.trim()) $("#login-message").textContent = "Adresse prête : appuyez sur « Recevoir mon lien ».";
};
$("#signout").onclick = async () => { if (confirm("Voulez-vous vraiment vous déconnecter ? Vos notes restent sauvegardées et synchronisées.")) { await sbClient.auth.signOut(); account(null); } };
window.addEventListener("online", sync); window.addEventListener("hashchange", route);

// --- Thème et démarrage. ---
function setTheme(isDark) { document.body.classList.toggle("dark", isDark); localStorage.setItem("organiseur-theme", isDark ? "dark" : "light"); document.querySelectorAll("[data-theme-toggle]").forEach((button) => { const label = isDark ? "Activer le mode clair" : "Activer le mode sombre"; button.textContent = isDark ? "☀" : "☾"; button.setAttribute("aria-label", label); button.title = label; button.setAttribute("aria-pressed", String(isDark)); }); }
const themeButton = document.createElement("button"); themeButton.type = "button"; themeButton.className = "theme-toggle"; themeButton.dataset.themeToggle = ""; $("#clock").before(themeButton);
[themeButton, $("#theme-toggle-login")].forEach((button) => { button.dataset.themeToggle = ""; button.onclick = () => setTheme(!document.body.classList.contains("dark")); });
$("#brand-reveal").onclick = toggleNavigation;
$("#brand-reveal").onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleNavigation(); } };

async function init() {
  [tasks, notes] = await Promise.all([all("tasks"), all("notes")]); await runDailyTaskArchiveIfDue(); scheduleDailyTaskArchive(); renderTasks(); renderNotes(); renderMarkdownWorkspace(); renderCalendar(); route(); updateClock(); setInterval(updateClock, 1000); setTheme(localStorage.getItem("organiseur-theme") === "dark"); account(null); updateEmailCooldown();
  if (!configured) return;
  const { data: { session } } = await sbClient.auth.getSession(); account(session?.user || null);
  if (session?.user) { await sync(); await runDailyTaskArchiveIfDue(); await sync(); await subscribe(); }
  sbClient.auth.onAuthStateChange(async (_event, state) => { account(state?.user || null); if (state?.user) { await sync(); await runDailyTaskArchiveIfDue(); await sync(); await subscribe(); } });
}
init().catch((error) => { console.error(error); status("Erreur"); });
