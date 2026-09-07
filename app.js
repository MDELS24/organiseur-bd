/* Organiseur MD : interface locale, authentification et synchronisation Supabase. */
const { url: SUPABASE_URL, publishableKey: SUPABASE_PUBLISHABLE_KEY } = window.SUPABASE_CONFIG;
const configured = SUPABASE_URL.startsWith("https://") && SUPABASE_PUBLISHABLE_KEY.length > 20;
const sbClient = configured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) : null;
const $ = (selector) => document.querySelector(selector);
const DB_NAME = "organiseur-bd";
const QUEUE = "queue";
const MONTHS = ["JANVIER", "FÉVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOÛT", "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DÉCEMBRE"];

let tasks = [], notes = [], selectedNoteId = null, user = null, noteTimer = null, todoChannel = null, noteChannel = null;

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

// --- État, thème et navigation. ---
function updateClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
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
  status(!configured ? "Erreur" : user ? "Synchronisé" : "Connexion requise");
  if (!configured) $("#login-message").textContent = "La configuration Supabase est indisponible.";
}
function route() {
  const view = ["notes", "calendar"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "todos";
  ["todos", "notes", "calendar"].forEach((id) => $("#" + id).classList.toggle("hidden", id !== view));
  document.querySelectorAll("[data-link]").forEach((link) => link.classList.toggle("active", link.dataset.link === view));
}

// --- Rendu. Les textes utilisateur passent toujours par textContent. ---
function renderTasks() {
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  const list = $("#task-list"); list.replaceChildren(); $("#tasks-empty").hidden = tasks.length > 0;
  tasks.forEach((task) => {
    const item = document.createElement("li"); item.className = `task${task.done ? " done" : ""}`;
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = task.done;
    check.onchange = async () => { task.done = check.checked; await change("tasks", task); renderTasks(); };
    const text = document.createElement("span"); text.textContent = task.text;
    const remove = document.createElement("button"); remove.className = "delete"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "Supprimer cette tâche");
    remove.onclick = () => deleteTask(task.id);
    item.append(check, text, remove); list.append(item);
  });
}
function renderNotes() {
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  const list = $("#notes-list"); list.replaceChildren(); $("#notes-empty").hidden = notes.length > 0;
  notes.forEach((note) => {
    const card = document.createElement("article"); card.className = `note-card${note.id === selectedNoteId ? " selected" : ""}`;
    const open = document.createElement("button"); open.className = "note-open"; open.type = "button"; open.setAttribute("aria-label", `Ouvrir ${note.title || "la note"}`);
    const title = document.createElement("strong"); title.textContent = note.title || "Sans titre";
    const preview = document.createElement("span"); preview.textContent = note.content || "Note vide";
    open.append(title, preview); open.onclick = () => { selectedNoteId = note.id; renderNotes(); };
    const remove = document.createElement("button"); remove.className = "delete note-delete"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "Supprimer cette note");
    remove.onclick = () => deleteNote(note.id); card.append(open, remove); list.append(card);
  });
  const note = notes.find((item) => item.id === selectedNoteId); const opened = !!note;
  ["#note-title", "#note-content", "#note-sync"].forEach((id) => $(id).classList.toggle("hidden", !opened));
  $("#editor-empty").hidden = opened;
  if (opened) { $("#note-title").value = note.title; $("#note-content").value = note.content; }
}
function renderCalendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const grid = $("#calendar-grid");
  const firstOfMonth = new Date(year, month, 1);
  const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);

  $("#calendar-month").textContent = MONTHS[month];
  $("#calendar-number").textContent = String(month + 1).padStart(2, "0");
  $("#calendar-year").textContent = year;
  grid.replaceChildren();

  // Six rangées, comme un calendrier de bureau. La première colonne est le n° de semaine ISO.
  for (let week = 0; week < 6; week += 1) {
    const monday = new Date(gridStart);
    monday.setDate(gridStart.getDate() + week * 7);
    const weekCell = document.createElement("span");
    weekCell.className = "calendar-week";
    weekCell.textContent = isoWeekNumber(monday);
    weekCell.setAttribute("aria-label", `Semaine ${weekCell.textContent}`);
    grid.append(weekCell);

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + weekday);
      const isCurrentMonth = date.getMonth() === month;
      const cell = document.createElement("time");

      if (!isCurrentMonth) {
        cell.className = "calendar-empty";
        cell.setAttribute("aria-hidden", "true");
        grid.append(cell);
        continue;
      }

      const isToday = date.toDateString() === today.toDateString();
      const weekendClass = weekday === 5 ? " saturday" : weekday === 6 ? " sunday" : "";
      cell.className = `calendar-day${isToday ? " today" : ""}${weekendClass}`;
      cell.textContent = date.getDate();
      cell.dateTime = `${year}-${String(month + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (isToday) cell.setAttribute("aria-label", `Aujourd’hui, le ${date.getDate()} ${MONTHS[month].toLowerCase()} ${year}`);
      grid.append(cell);
    }
  }
}
function isoWeekNumber(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return Math.ceil(((copy - yearStart) / 86400000 + 1) / 7);
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
async function deleteTask(id) { tasks = tasks.filter((task) => task.id !== id); await queueDeletion("tasks", id); renderTasks(); sync(); }
async function deleteNote(id) { notes = notes.filter((note) => note.id !== id); if (selectedNoteId === id) selectedNoteId = notes[0]?.id || null; await queueDeletion("notes", id); renderNotes(); sync(); }
async function flush() {
  if (!user || !navigator.onLine) return;
  for (const operation of await all(QUEUE)) {
    const request = operation.type === "delete"
      ? sbClient.from(operation.table).delete().eq("id", operation.record.id)
      : sbClient.from(operation.table).upsert({ id: operation.record.id, user_id: user.id, text: operation.record.text, title: operation.record.title, content: operation.record.content, done: operation.record.done, created_at: new Date(operation.record.createdAt).toISOString(), updated_at: new Date(operation.record.updatedAt).toISOString() });
    const { error } = await request; if (error) throw error; await drop(QUEUE, operation.id);
  }
}
async function pull(table) {
  const { data, error } = await sbClient.from(table).select("*").order("updated_at", { ascending: false }); if (error) throw error;
  const records = data.map((row) => table === "todos" ? ({ id: row.id, text: row.text, done: row.done, createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at) }) : ({ id: row.id, title: row.title, content: row.content, createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at) }));
  if (table === "todos") { tasks = records; await Promise.all(tasks.map((x) => put("tasks", x))); renderTasks(); }
  else { notes = records; if (!notes.some((x) => x.id === selectedNoteId)) selectedNoteId = notes[0]?.id || null; await Promise.all(notes.map((x) => put("notes", x))); renderNotes(); }
}
async function sync() {
  if (!configured || !user) return;
  try { status(navigator.onLine ? "Synchronisation" : "Hors ligne"); await flush(); await pull("todos"); await pull("notes"); account(user); }
  catch (error) { console.error(error); status("Hors ligne"); }
}
async function subscribe() {
  if (todoChannel) await sbClient.removeChannel(todoChannel); if (noteChannel) await sbClient.removeChannel(noteChannel);
  const options = { event: "*", schema: "public", filter: `user_id=eq.${user.id}` };
  todoChannel = sbClient.channel(`todos:${user.id}`).on("postgres_changes", { ...options, table: "todos" }, () => pull("todos")).subscribe();
  noteChannel = sbClient.channel(`notes:${user.id}`).on("postgres_changes", { ...options, table: "notes" }, () => pull("notes")).subscribe();
}

// --- Événements utilisateur. ---
$("#task-form").onsubmit = async (event) => { event.preventDefault(); const input = $("#task-input"), text = input.value.trim(); if (!text) return; const now = Date.now(), task = { id: crypto.randomUUID(), text, done: false, createdAt: now, updatedAt: now }; tasks.unshift(task); await change("tasks", task); input.value = ""; renderTasks(); };
$("#clear-done").onclick = async () => { const done = tasks.filter((task) => task.done); tasks = tasks.filter((task) => !task.done); await Promise.all(done.map((task) => queueDeletion("tasks", task.id))); renderTasks(); sync(); };
$("#new-note").onclick = async () => { const now = Date.now(), note = { id: crypto.randomUUID(), title: "Nouvelle note", content: "", createdAt: now, updatedAt: now }; notes.unshift(note); selectedNoteId = note.id; await change("notes", note); renderNotes(); $("#note-title").focus(); $("#note-title").select(); };
function saveNoteSoon() { const note = notes.find((item) => item.id === selectedNoteId); if (!note) return; note.title = $("#note-title").value.slice(0, 160); note.content = $("#note-content").value; clearTimeout(noteTimer); noteTimer = setTimeout(async () => { await change("notes", note); renderNotes(); }, 450); }
$("#note-title").oninput = saveNoteSoon; $("#note-content").oninput = saveNoteSoon;
$("#delete-note").onclick = () => selectedNoteId && deleteNote(selectedNoteId);
$("#login-form").onsubmit = async (event) => { event.preventDefault(); const { error } = await sbClient.auth.signInWithOtp({ email: $("#login-email").value, options: { emailRedirectTo: new URL(".", location.href).href } }); $("#login-message").textContent = error ? error.message : "Lien envoyé : vérifiez vos e-mails puis ouvrez le lien."; };
$("#signout").onclick = async () => { if (confirm("Voulez-vous vraiment vous déconnecter ? Vos notes restent sauvegardées et synchronisées.")) { await sbClient.auth.signOut(); account(null); } };
window.addEventListener("online", sync); window.addEventListener("hashchange", route);

// --- Thème et démarrage. ---
function setTheme(isDark) { document.body.classList.toggle("dark", isDark); localStorage.setItem("organiseur-theme", isDark ? "dark" : "light"); document.querySelectorAll("[data-theme-toggle]").forEach((button) => { const label = isDark ? "Activer le mode clair" : "Activer le mode sombre"; button.textContent = isDark ? "☀" : "☾"; button.setAttribute("aria-label", label); button.title = label; button.setAttribute("aria-pressed", String(isDark)); }); }
const themeButton = document.createElement("button"); themeButton.type = "button"; themeButton.className = "theme-toggle"; themeButton.dataset.themeToggle = ""; $("#clock").before(themeButton);
[themeButton, $("#theme-toggle-login")].forEach((button) => { button.dataset.themeToggle = ""; button.onclick = () => setTheme(!document.body.classList.contains("dark")); });

async function init() {
  [tasks, notes] = await Promise.all([all("tasks"), all("notes")]); renderTasks(); renderNotes(); renderCalendar(); route(); updateClock(); setInterval(updateClock, 1000); setTheme(localStorage.getItem("organiseur-theme") === "dark"); account(null);
  if (!configured) return;
  const { data: { session } } = await sbClient.auth.getSession(); account(session?.user || null);
  if (session?.user) { await sync(); await subscribe(); }
  sbClient.auth.onAuthStateChange(async (_event, state) => { account(state?.user || null); if (state?.user) { await sync(); await subscribe(); } });
}
init().catch((error) => { console.error(error); status("Erreur"); });
