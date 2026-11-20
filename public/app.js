const categories = ["All", "Notice", "Event", "Exam", "Result", "Download"];
const API_BASE_URL = document.querySelector('meta[name="api-base-url"]').content.replace(/\/$/, "");
const ADMIN_TOKEN_KEY = "noticehub_admin_token";
let recoveryToken = new URLSearchParams(window.location.search).get("resetToken");
const filters = document.querySelector("#filters");
const noticeGrid = document.querySelector("#notice-grid");
const emptyState = document.querySelector("#empty-state");
const loadError = document.querySelector("#load-error");
const searchInput = document.querySelector("#notice-search");
const sortSelect = document.querySelector("#notice-sort");
const feedStatus = document.querySelector("#feed-status");
const detailModal = document.querySelector("#detail-modal");
const adminModal = document.querySelector("#admin-modal");
const loginForm = document.querySelector("#login-form");
const forgotForm = document.querySelector("#forgot-form");
const resetForm = document.querySelector("#reset-form");
const noticeForm = document.querySelector("#notice-form");
let activeCategory = "All";
let managedNotices = [];
let isAdmin = false;
let searchTimer;
let feedRequestId = 0;

document.querySelector("#year").textContent = new Date().getFullYear();

if (recoveryToken) {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("resetToken");
  window.history.replaceState(null, "", cleanUrl);
}

function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  const method = (options.method || "GET").toUpperCase();
  const requiresToken = path === "/api/admin/session" ||
    (path === "/api/admin/logout" && method === "POST") ||
    (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/notices"));
  if (token && requiresToken) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers }).then((response) => {
    if (response.status === 401 && token && requiresToken) {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      if (isAdmin) {
        isAdmin = false;
        showAdminView();
      }
    }
    return response;
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderFilters() {
  filters.replaceChildren();
  for (const category of categories) {
    const button = makeElement("button", `filter-chip${activeCategory === category ? " active" : ""}`, category);
    button.type = "button";
    button.setAttribute("aria-pressed", String(activeCategory === category));
    button.addEventListener("click", () => {
      activeCategory = category;
      renderFilters();
      loadNotices();
    });
    filters.append(button);
  }
}

function renderNotices(items) {
  noticeGrid.replaceChildren();
  for (const notice of items) {
    const card = makeElement("article", "notice-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Read ${notice.title}`);
    const meta = makeElement("div", "card-meta");
    const tag = makeElement("span", "category-tag", notice.category);
    tag.dataset.category = notice.category;
    const date = makeElement("time", "card-date", formatDate(notice.createdAt));
    date.dateTime = notice.createdAt;
    meta.append(tag, date);
    const title = makeElement("h3", "", notice.title);
    const excerpt = makeElement("p", "notice-excerpt", notice.description);
    const bottom = makeElement("div", "card-bottom");
    bottom.append(
      makeElement("span", "", notice.fileUrl ? "PDF link" : "Campus update"),
      makeElement("span", "card-read", "Read more ↗")
    );
    if (notice.fileUrl) bottom.firstChild.className = "attachment-mark";
    card.append(meta, title, excerpt, bottom);
    card.addEventListener("click", () => showDetails(notice));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showDetails(notice);
      }
    });
    noticeGrid.append(card);
  }
  emptyState.hidden = items.length > 0;
  document.querySelector("#empty-title").textContent =
    searchInput.value.trim() ? "No matching updates" : "No updates just yet";
  document.querySelector("#empty-message").textContent =
    searchInput.value.trim()
      ? "Try a different search or clear the selected filters."
      : "Try another category or check back soon.";
}

async function loadNotices() {
  const requestId = ++feedRequestId;
  loadError.hidden = true;
  feedStatus.textContent = "Loading campus updates…";
  noticeGrid.setAttribute("aria-busy", "true");
  document.querySelector("#refresh-notices").disabled = true;
  try {
    const params = new URLSearchParams({ sort: sortSelect.value });
    if (activeCategory !== "All") params.set("category", activeCategory);
    if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
    const query = `?${params}`;
    const response = await apiFetch(`/api/notices${query}`);
    if (!response.ok) throw new Error("Could not load notices.");
    const notices = await response.json();
    if (requestId !== feedRequestId) return;
    renderNotices(notices);
    feedStatus.textContent = `${notices.length} ${notices.length === 1 ? "update" : "updates"}`;
  } catch {
    if (requestId !== feedRequestId) return;
    noticeGrid.replaceChildren();
    emptyState.hidden = true;
    loadError.hidden = false;
    feedStatus.textContent = "";
  } finally {
    if (requestId === feedRequestId) {
      noticeGrid.setAttribute("aria-busy", "false");
      document.querySelector("#refresh-notices").disabled = false;
    }
  }
}

function showDetails(notice) {
  document.querySelector("#detail-category").textContent = notice.category;
  document.querySelector("#detail-title").textContent = notice.title;
  document.querySelector("#detail-date").textContent = formatDate(notice.createdAt);
  document.querySelector("#detail-description").textContent = notice.description;
  const download = document.querySelector("#detail-download");
  download.hidden = !notice.fileUrl;
  download.href = notice.fileUrl || "#";
  download.target = "_blank";
  download.rel = "noopener noreferrer";
  download.textContent = "View / download PDF";
  const arrow = makeElement("span", "", "↗");
  download.append(arrow);
  detailModal.showModal();
}

document.querySelectorAll(".modal-close").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
for (const modal of [detailModal, adminModal]) {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.close();
  });
}

async function openAdminPanel() {
  adminModal.showModal();
  if (recoveryToken) {
    showAuthPanel(resetForm);
    return;
  }
  document.querySelector("#login-error").textContent = "";
  try {
    const response = await apiFetch("/api/admin/session");
    isAdmin = response.ok;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  showAdminView();
  if (isAdmin) loadAdminNotices();
}

document.querySelector("#admin-open").addEventListener("click", openAdminPanel);
document.querySelector("#staff-open").addEventListener("click", openAdminPanel);

function showAdminView() {
  document.querySelector("#admin-login").hidden = isAdmin;
  document.querySelector("#admin-dashboard").hidden = !isAdmin;
}

function showAuthPanel(panel) {
  document.querySelectorAll(".auth-panel").forEach((item) => {
    item.hidden = item !== panel;
  });
  document.querySelectorAll(".form-error, .form-message").forEach((item) => {
    item.textContent = "";
  });
}

document.querySelector("#forgot-open").addEventListener("click", () => showAuthPanel(forgotForm));
document.querySelector("#login-return").addEventListener("click", () => showAuthPanel(loginForm));
document.querySelector("#reset-return").addEventListener("click", () => {
  recoveryToken = null;
  showAuthPanel(loginForm);
});

forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = forgotForm.querySelector('button[type="submit"]');
  button.disabled = true;
  document.querySelector("#forgot-error").textContent = "";
  document.querySelector("#forgot-message").textContent = "";
  try {
    const response = await apiFetch("/api/admin/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(forgotForm)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not request a reset link.");
    document.querySelector("#forgot-message").textContent = result.message;
    forgotForm.reset();
  } catch (error) {
    document.querySelector("#forgot-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = resetForm.elements.password.value;
  const confirmPassword = resetForm.elements.confirmPassword.value;
  if (!recoveryToken) {
    document.querySelector("#reset-error").textContent = "This reset link is invalid or has expired.";
    return;
  }
  if (password !== confirmPassword) {
    document.querySelector("#reset-error").textContent = "The passwords do not match.";
    return;
  }
  if (new TextEncoder().encode(password).length > 72) {
    document.querySelector("#reset-error").textContent = "Password must be no more than 72 UTF-8 bytes.";
    return;
  }

  const button = resetForm.querySelector('button[type="submit"]');
  button.disabled = true;
  document.querySelector("#reset-error").textContent = "";
  try {
    const response = await apiFetch("/api/admin/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: recoveryToken, password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not reset the password.");
    recoveryToken = null;
    resetForm.reset();
    showAuthPanel(loginForm);
    document.querySelector("#login-message").textContent = result.message;
  } catch (error) {
    document.querySelector("#reset-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  document.querySelector("#login-error").textContent = "";
  document.querySelector("#login-message").textContent = "";
  try {
    const response = await apiFetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(loginForm)))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed.");
    sessionStorage.setItem(ADMIN_TOKEN_KEY, result.token);
    isAdmin = true;
    loginForm.reset();
    showAdminView();
    await loadAdminNotices();
  } catch (error) {
    document.querySelector("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function loadAdminNotices() {
  try {
    const sessionResponse = await apiFetch("/api/admin/session");
    if (sessionResponse.status === 401) {
      isAdmin = false;
      showAdminView();
      return;
    }
    if (!sessionResponse.ok) throw new Error("Could not verify the admin session.");
    const response = await apiFetch("/api/notices");
    if (!response.ok) throw new Error("Could not load notices.");
    managedNotices = await response.json();
    renderManagedNotices();
  } catch (error) {
    document.querySelector("#notice-error").textContent = error.message;
  }
}

function renderManagedNotices() {
  const list = document.querySelector("#managed-list");
  list.replaceChildren();
  document.querySelector("#managed-count").textContent = `${managedNotices.length} total`;
  for (const notice of managedNotices) {
    const item = makeElement("div", "managed-item");
    const info = makeElement("div");
    const title = makeElement("span", "managed-item-title", notice.title);
    const category = makeElement("span", "managed-item-category", notice.category);
    title.append(category);
    info.append(title);
    const actions = makeElement("div", "managed-actions");
    const edit = makeElement("button", "", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => beginEdit(notice));
    const remove = makeElement("button", "delete-button", "Delete");
    remove.type = "button";
    remove.addEventListener("click", () => deleteNotice(notice));
    actions.append(edit, remove);
    item.append(info, actions);
    list.append(item);
  }
}

function beginEdit(notice) {
  noticeForm.elements.noticeId.value = notice.id;
  noticeForm.elements.title.value = notice.title;
  noticeForm.elements.category.value = notice.category;
  noticeForm.elements.description.value = notice.description;
  noticeForm.elements.fileUrl.value = notice.fileUrl || "";
  document.querySelector("#save-notice").innerHTML = 'Save changes <span>↗</span>';
  document.querySelector("#cancel-edit").hidden = false;
  document.querySelector("#notice-error").textContent = "";
  noticeForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetNoticeForm() {
  noticeForm.reset();
  noticeForm.elements.noticeId.value = "";
  document.querySelector("#save-notice").innerHTML = 'Publish update <span>↗</span>';
  document.querySelector("#cancel-edit").hidden = true;
}

document.querySelector("#cancel-edit").addEventListener("click", resetNoticeForm);

noticeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const noticeId = noticeForm.elements.noticeId.value;
  const formData = Object.fromEntries(new FormData(noticeForm));
  delete formData.noticeId;
  if (!formData.fileUrl) delete formData.fileUrl;
  const button = document.querySelector("#save-notice");
  button.disabled = true;
  document.querySelector("#notice-error").textContent = "";
  try {
    const response = await apiFetch(noticeId ? `/api/notices/${encodeURIComponent(noticeId)}` : "/api/notices", {
      method: noticeId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData)
    });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(result?.error || "Could not save this update.");
    resetNoticeForm();
    await loadAdminNotices();
    await loadNotices();
  } catch (error) {
    document.querySelector("#notice-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function deleteNotice(notice) {
  if (!window.confirm(`Delete "${notice.title}"? This cannot be undone.`)) return;
  try {
    const response = await apiFetch(`/api/notices/${encodeURIComponent(notice.id)}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Could not delete this update.");
    }
    await loadAdminNotices();
    await loadNotices();
  } catch (error) {
    document.querySelector("#notice-error").textContent = error.message;
  }
}

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await apiFetch("/api/admin/logout", { method: "POST" });
  } finally {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    isAdmin = false;
    showAdminView();
    resetNoticeForm();
  }
});

document.querySelector("#retry-load").addEventListener("click", loadNotices);
document.querySelector("#refresh-notices").addEventListener("click", loadNotices);
document.querySelector("#clear-filters").addEventListener("click", () => {
  activeCategory = "All";
  searchInput.value = "";
  sortSelect.value = "newest";
  renderFilters();
  loadNotices();
});
searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadNotices, 250);
});
sortSelect.addEventListener("change", loadNotices);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});
renderFilters();
loadNotices();
if (recoveryToken) {
  adminModal.showModal();
  showAuthPanel(resetForm);
}
