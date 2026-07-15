(function () {
  const seed = window.StoreAssistantSeed || {};
  const store = seed.store || {};
  let employees = loadEmployees();
  let currentUser = loadCurrentUser();
  let products = loadProducts();
  let productPhotos = [];
  let sitePublications = loadSitePublications();
  let avitoDrafts = loadAvitoDrafts();
  let avitoPhotosBySku = loadAvitoPhotos();
  let activeAvitoProductIndex = null;
  let questions = loadQuestions();
  let activeReplyQuestionId = null;
  const tasks = loadTasks();
  const activity = seed.activity || [];

  const roleRules = {
    owner: {
      label: "Начальник",
      canViewFinance: true,
      canManageEmployees: true,
      canManageSystem: true,
      canImportSite: true
    },
    admin: {
      label: "Админ",
      canViewFinance: true,
      canManageEmployees: true,
      canManageSystem: true,
      canImportSite: true
    },
    seller: {
      label: "Продавец",
      canViewFinance: false,
      canManageEmployees: false,
      canManageSystem: false,
      canImportSite: false
    }
  };

  const rub = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  });

  const defaultChat = [
    {
      role: "assistant",
      title: "Ассистент",
      body: "Привет. Я демо-ассистент магазина. Могу сделать сводку, найти проблемные товары, подготовить задачи и сформировать текст для владельца."
    }
  ];

  let chatHistory = loadChat();

  function byId(id) {
    return document.getElementById(id);
  }

  function money(value) {
    return rub.format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeXml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function downloadTextFile(filename, content, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function normalizeEmployee(employee) {
    const role = employee.role || "seller";
    return {
      name: employee.name || "Новый сотрудник",
      login: employee.login || `user${Date.now()}`,
      password: employee.password || "1234",
      role,
      roleLabel: employee.roleLabel || roleRules[role]?.label || "Сотрудник",
      active: employee.active !== false
    };
  }

  function getSeedEmployees() {
    return (seed.employees || []).map(normalizeEmployee);
  }

  function loadEmployees() {
    try {
      const saved = localStorage.getItem("storeAssistantEmployees");
      return saved ? JSON.parse(saved).map(normalizeEmployee) : getSeedEmployees();
    } catch {
      return getSeedEmployees();
    }
  }

  function saveEmployees() {
    localStorage.setItem("storeAssistantEmployees", JSON.stringify(employees));
  }

  function loadCurrentUser() {
    try {
      const saved = sessionStorage.getItem("storeAssistantCurrentUser");
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      const employee = employees.find((item) => item.login === parsed.login && item.active);
      return employee || null;
    } catch {
      return null;
    }
  }

  function saveCurrentUser(user) {
    if (user) {
      sessionStorage.setItem("storeAssistantCurrentUser", JSON.stringify({ login: user.login }));
    } else {
      sessionStorage.removeItem("storeAssistantCurrentUser");
    }
  }

  function getRoleRule(user = currentUser) {
    return roleRules[user?.role] || roleRules.seller;
  }

  function can(permission) {
    const rules = getRoleRule();
    if (permission === "finance") return rules.canViewFinance;
    if (permission === "manage-employees") return rules.canManageEmployees;
    if (permission === "manage-system") return rules.canManageSystem;
    if (permission === "site-import") return rules.canImportSite;
    return true;
  }

  function normalizeProduct(product) {
    return {
      sku: product.sku || `SKU-${Date.now()}`,
      name: product.name || "Новый товар",
      category: product.category || "Без категории",
      status: product.status || "Остаток",
      days: Number(product.days ?? product.daysInSale ?? 0),
      cost: Number(product.cost ?? product.costPrice ?? 0),
      price: Number(product.price ?? product.salePrice ?? 0),
      stock: Number(product.stock ?? product.stockQty ?? 0),
      source: product.source || "demo",
      comment: product.comment || "",
      condition: product.condition || "Отличное",
      kit: product.kit || product.package || "",
      description: product.description || product.comment || "",
      photosCount: Number(product.photosCount ?? product.photoCount ?? 0),
      photoUrls: Array.isArray(product.photoUrls)
        ? product.photoUrls
        : String(product.photoUrls || "").split(/[;,\n]/).map((url) => url.trim()).filter(Boolean),
      photoSource: product.photoSource || product.photo_source || "",
      avitoStatus: product.avitoStatus || "",
      avitoModeration: product.avitoModeration || "",
      avitoModerationScore: Number(product.avitoModerationScore ?? 0)
    };
  }

  function getSeedProducts() {
    return (seed.products || []).map(normalizeProduct);
  }

  function loadProducts() {
    try {
      const saved = localStorage.getItem("storeAssistantProducts");
      if (!saved) return getSeedProducts();

      const seedBySku = new Map(getSeedProducts().map((product) => [product.sku, product]));
      return JSON.parse(saved).map(normalizeProduct).map((product) => {
        const seedProduct = seedBySku.get(product.sku);
        if (!seedProduct) return product;
        return {
          ...product,
          condition: product.condition || seedProduct.condition,
          kit: product.kit || seedProduct.kit,
          description: product.description && product.description !== product.comment ? product.description : seedProduct.description || product.description,
          photosCount: product.photosCount || seedProduct.photosCount,
          avitoStatus: product.avitoStatus || ""
        };
      });
    } catch {
      return getSeedProducts();
    }
  }

  function saveProducts() {
    localStorage.setItem("storeAssistantProducts", JSON.stringify(products));
  }

  function loadSitePublications() {
    try {
      const saved = localStorage.getItem("storeAssistantSitePublications");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  function saveSitePublications() {
    localStorage.setItem("storeAssistantSitePublications", JSON.stringify(sitePublications));
  }

  function loadAvitoDrafts() {
    try {
      const saved = localStorage.getItem("storeAssistantAvitoDrafts");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  function saveAvitoDrafts() {
    localStorage.setItem("storeAssistantAvitoDrafts", JSON.stringify(avitoDrafts));
  }

  function loadAvitoPhotos() {
    try {
      const saved = localStorage.getItem("storeAssistantAvitoPhotos");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  }

  function saveAvitoPhotos() {
    localStorage.setItem("storeAssistantAvitoPhotos", JSON.stringify(avitoPhotosBySku));
  }

  function getDefaultQuestions() {
    return (seed.questions || []).map((item, index) => ({
      id: item.id || index + 1,
      type: item.type || "Вопрос",
      priority: item.priority || "Обычный",
      title: item.title || "Вопрос",
      text: item.text || "",
      authorName: item.authorName || "Сотрудник",
      authorLogin: item.authorLogin || "unknown",
      status: item.status || "open",
      createdAt: item.createdAt || new Date().toLocaleString("ru-RU"),
      answer: item.answer || "",
      answeredBy: item.answeredBy || "",
      answeredAt: item.answeredAt || ""
    }));
  }

  function loadQuestions() {
    try {
      const saved = localStorage.getItem("storeAssistantQuestions");
      return saved ? JSON.parse(saved) : getDefaultQuestions();
    } catch {
      return getDefaultQuestions();
    }
  }

  function saveQuestions() {
    localStorage.setItem("storeAssistantQuestions", JSON.stringify(questions));
  }

  function loadTasks() {
    try {
      const saved = localStorage.getItem("storeAssistantTasks");
      return saved ? JSON.parse(saved) : structuredClone(seed.tasks || []);
    } catch {
      return (seed.tasks || []).map((task) => ({ ...task }));
    }
  }

  function saveTasks() {
    localStorage.setItem("storeAssistantTasks", JSON.stringify(tasks));
  }

  function loadChat() {
    try {
      const saved = sessionStorage.getItem("storeAssistantChat");
      return saved ? JSON.parse(saved) : structuredClone(defaultChat);
    } catch {
      return defaultChat.map((message) => ({ ...message }));
    }
  }

  function saveChat() {
    sessionStorage.setItem("storeAssistantChat", JSON.stringify(chatHistory));
  }

  function getRevenue() {
    const fallback = seed.metrics || {};
    return Number(fallback.cashSales || 0) + Number(fallback.cardSales || 0) + Number(fallback.transfers || 0);
  }

  function getProfit() {
    return products.reduce((sum, product) => sum + Math.max(product.price - product.cost, 0), 0);
  }

  function getStockUnits() {
    return products.reduce((sum, product) => sum + Math.max(product.stock, 0), 0);
  }

  function getStockCostValue() {
    return products.reduce((sum, product) => sum + Math.max(product.stock, 0) * Math.max(product.cost, 0), 0);
  }

  function getStockSaleValue() {
    return products.reduce((sum, product) => sum + Math.max(product.stock, 0) * Math.max(product.price, 0), 0);
  }

  function getLowStockProducts() {
    return products.filter((product) => product.stock <= 2);
  }

  function getAttentionProducts() {
    return products.filter((product) => product.days >= 30 || product.stock <= 2 || product.status === "На диагностике");
  }

  function getFieldNumber(id, fallback) {
    const field = byId(id);
    return field ? Number(field.value || 0) : Number(fallback || 0);
  }

  function getFieldText(id, fallback) {
    const field = byId(id);
    return field ? field.value.trim() : String(fallback || "");
  }

  function getShiftValues() {
    const shift = seed.shift || {};
    const cashStart = getFieldNumber("cashStart", shift.cashStart);
    const cashSales = getFieldNumber("cashSales", shift.cashSales);
    const cardSales = getFieldNumber("cardSales", shift.cardSales);
    const transfers = getFieldNumber("transfers", shift.transfers);
    const refunds = getFieldNumber("refunds", shift.refunds);
    const expenses = getFieldNumber("expenses", shift.expenses);
    const collection = getFieldNumber("collection", shift.collection);
    const cashActual = getFieldNumber("cashActual", shift.cashActual);
    const expected = cashStart + cashSales - refunds - expenses - collection;
    const difference = cashActual - expected;
    const totalRevenue = cashSales + cardSales + transfers;
    return { cashStart, cashSales, cardSales, transfers, refunds, expenses, collection, cashActual, expected, difference, totalRevenue };
  }

  function getOwnerDigest() {
    if (!can("finance")) {
      const lowStock = getLowStockProducts();
      return [
        `Рабочая сводка для ${currentUser?.name || "сотрудника"}:`,
        "",
        `На складе: ${getStockUnits()} единиц товара.`,
        `Открытых задач: ${tasks.filter((task) => !task.done).length}.`,
        `Товаров, требующих внимания: ${getAttentionProducts().length}.`,
        lowStock.length ? `Низкий остаток: ${lowStock.map((item) => `${item.name} — ${item.stock} шт.`).join("; ")}.` : "Критичных остатков нет.",
        "",
        "Финансы владельца и управление сотрудниками в роли продавца скрыты."
      ].join("\n");
    }

    const stale = products.filter((product) => product.days >= 30);
    const lowStock = products.filter((product) => product.stock <= 2 && product.category === "Аксессуары");
    const diff = getShiftValues().difference;
    return [
      `Короткая сводка для ${store.ownerName || "владельца"}:`,
      "",
      `Выручка по тестовой смене: ${money(getRevenue())}.`,
      `Оценочная маржа по активным позициям: ${money(getProfit())}.`,
      `Товаров, требующих внимания: ${getAttentionProducts().length}.`,
      stale.length ? `Давно в продаже: ${stale.map((item) => item.name).join(", ")}.` : "Залежавшихся товаров нет.",
      lowStock.length ? `Нужно пополнить остатки: ${lowStock.map((item) => item.name).join(", ")}.` : "Критичных остатков нет.",
      diff !== 0 ? `По смене есть расхождение: ${money(diff)}.` : "По смене расхождений нет.",
      "",
      "Рекомендация: начать с цены iPhone 15 Pro, фото AirPods Pro 2 и заказа USB-C кабелей."
    ].join("\n");
  }

  function renderMetrics() {
    const target = byId("metrics");
    if (!target) return;

    const metrics = can("finance")
      ? [
          { label: "Выручка сегодня", value: money(getRevenue()), context: "Наличные, карта и переводы" },
          { label: "Оценочная маржа", value: money(getProfit()), context: "По демо-товарам" },
          { label: "Открытые задачи", value: String(tasks.filter((task) => !task.done).length), context: "Нужно закрыть сегодня" },
          { label: "Внимание", value: String(getAttentionProducts().length), context: "Товары, остатки и касса", attention: true }
        ]
      : [
          { label: "Рабочая смена", value: "Открыта", context: currentUser ? `${currentUser.name}, ${currentUser.roleLabel}` : "Сотрудник" },
          { label: "Единиц на складе", value: String(getStockUnits()), context: "Все остатки" },
          { label: "Открытые задачи", value: String(tasks.filter((task) => !task.done).length), context: "К выполнению" },
          { label: "Низкий остаток", value: String(getLowStockProducts().length), context: "Нужно проверить", attention: true }
        ];

    target.innerHTML = metrics.map((item) => `
      <article class="metric-card ${item.attention ? "attention" : ""}">
        <div class="metric-label">${item.label}</div>
        <div class="metric-value">${item.value}</div>
        <div class="metric-context">${item.context}</div>
      </article>
    `).join("");
  }

  function renderInventoryMetrics() {
    const target = byId("inventoryMetrics");
    if (!target) return;

    const metrics = can("finance")
      ? [
          { label: "Позиций", value: String(products.length), context: "Уникальные карточки" },
          { label: "Единиц на складе", value: String(getStockUnits()), context: "Сумма всех остатков" },
          { label: "Себестоимость товаров", value: money(getStockCostValue()), context: "Закупка × остаток" },
          { label: "Потенциальная выручка", value: money(getStockSaleValue()), context: "Продажа × остаток" },
          { label: "Низкий остаток", value: String(getLowStockProducts().length), context: "2 шт. или меньше", attention: true }
        ]
      : [
          { label: "Позиций", value: String(products.length), context: "Уникальные карточки" },
          { label: "Единиц на складе", value: String(getStockUnits()), context: "Сумма всех остатков" },
          { label: "Готово к продаже", value: String(products.filter((product) => product.status === "Готов к продаже" || product.status === "Опубликован").length), context: "Можно предлагать клиенту" },
          { label: "На диагностике", value: String(products.filter((product) => product.status === "На диагностике").length), context: "Нужно проверить" },
          { label: "Низкий остаток", value: String(getLowStockProducts().length), context: "2 шт. или меньше", attention: true }
        ];

    target.innerHTML = metrics.map((item) => `
      <article class="metric-card ${item.attention ? "attention" : ""}">
        <div class="metric-label">${item.label}</div>
        <div class="metric-value">${item.value}</div>
        <div class="metric-context">${item.context}</div>
      </article>
    `).join("");
  }

  function renderAttention() {
    const list = byId("attentionList");
    if (!list) return;

    const items = [
      ...products.filter((product) => product.days >= 30).map((product) => ({
        title: `${product.name} давно в продаже`,
        meta: `${product.days} дней. Проверь цену, фото и площадки.`,
        type: "warning"
      })),
      ...products.filter((product) => product.stock <= 2 && product.category === "Аксессуары").map((product) => ({
        title: `Низкий остаток: ${product.name}`,
        meta: `Осталось ${product.stock} шт. Нужно запланировать закупку.`,
        type: "danger"
      })),
      {
        title: "Расхождение по закрытию смены",
        meta: "Фактический остаток ниже ожидаемого. Нужна проверка операций.",
        type: "danger"
      },
      {
        title: "Карточка iPhone 13 не завершена",
        meta: "Не хватает финального фото и результата диагностики.",
        type: "blue"
      }
    ];

    const counter = byId("attentionCount");
    if (counter) counter.textContent = `${items.length} пунктов`;
    list.innerHTML = items.map((item) => `
      <article class="attention-item">
        <span class="status-pill ${item.type}">${item.type === "danger" ? "Важно" : item.type === "blue" ? "Процесс" : "Проверить"}</span>
        <div class="attention-title">${escapeHtml(item.title)}</div>
        <div class="attention-meta">${escapeHtml(item.meta)}</div>
      </article>
    `).join("");
  }

  function renderActivity() {
    const target = byId("activityList");
    if (!target) return;

    target.innerHTML = activity.map((item) => `
      <article class="activity-item">
        <div class="attention-title">${escapeHtml(item.title)}</div>
        <div class="activity-meta">${escapeHtml(item.meta)}</div>
      </article>
    `).join("");
  }

  function renderDigest() {
    const title = byId("digestTitle");
    if (title) title.textContent = can("finance") ? "Сводка для владельца" : "Рабочая сводка";

    const target = byId("ownerDigest");
    if (target) target.textContent = getOwnerDigest();
  }

  function renderChat() {
    const messages = chatHistory.map((message) => `
      <article class="message ${message.role}">
        <div class="message-title">${escapeHtml(message.title)}</div>
        <div class="message-body">${escapeHtml(message.body)}</div>
      </article>
    `).join("");

    [byId("chatBox"), byId("floatingChatBox")].filter(Boolean).forEach((box) => {
      box.innerHTML = messages;
      box.scrollTop = box.scrollHeight;
    });
  }

  function assistantAnswer(prompt) {
    const q = prompt.toLowerCase();
    const stale = products.filter((product) => product.days >= 30);
    const diff = getShiftValues().difference;

    if (q.includes("вниман") || q.includes("важн") || q.includes("сегодня")) {
      return [
        "Сегодня я бы проверил 4 вещи:",
        "",
        `1. Касса: расхождение ${money(diff)}.`,
        "2. iPhone 15 Pro лежит 46 дней, стоит проверить цену и объявление.",
        "3. Осталось мало USB-C кабелей, можно потерять допродажи.",
        "4. AirPods Pro 2 пора обновить фотографиями и заголовком."
      ].join("\n");
    }

    if (q.includes("залеж") || q.includes("давно") || q.includes("не прода")) {
      return stale.length
        ? `Давно в продаже:\n\n${stale.map((item) => `- ${item.name}: ${item.days} дней, цена ${money(item.price)}. ${item.comment}`).join("\n")}`
        : "По тестовым данным залежавшихся товаров нет.";
    }

    if (q.includes("склад") || q.includes("остат") || q.includes("налич")) {
      const lowStock = getLowStockProducts();
      return [
        "Сводка по товарам:",
        "",
        `Всего позиций: ${products.length}.`,
        `Всего единиц товара: ${getStockUnits()}.`,
        `Себестоимость остатков: ${money(getStockCostValue())}.`,
        `Потенциальная выручка по остаткам: ${money(getStockSaleValue())}.`,
        lowStock.length ? `Низкий остаток: ${lowStock.map((item) => `${item.name} — ${item.stock} шт.`).join("; ")}.` : "Критичных остатков нет."
      ].join("\n");
    }

    if (q.includes("отчет") || q.includes("лёни") || q.includes("лёне") || q.includes("лене") || q.includes("леонид")) {
      return getOwnerDigest();
    }

    if (q.includes("продвиг")) {
      return [
        "Сегодня лучше продвигать PlayStation 5 Slim и защитные стекла для iPhone 15.",
        "",
        "Почему:",
        "- у PS5 хорошая маржа и понятный спрос;",
        "- стекла дают быстрые допродажи;",
        "- iPhone 15 Pro лучше сначала переоценить, а потом продвигать."
      ].join("\n");
    }

    if (q.includes("задач")) {
      return tasks
        .filter((task) => !task.done)
        .map((task, index) => `${index + 1}. ${task.title}. Ответственный: ${task.owner}. Срок: ${task.due}.`)
        .join("\n");
    }

    if (q.includes("вопрос") || q.includes("лёне") || q.includes("лене")) {
      const openQuestions = questions.filter((item) => item.status !== "done");
      return openQuestions.length
        ? `Открытые вопросы:\n\n${openQuestions.map((item, index) => `${index + 1}. ${item.title} — ${item.authorName}, ${item.priority}.`).join("\n")}`
        : "Открытых вопросов к Лёне нет.";
    }

    if (q.includes("теря") || q.includes("деньг") || q.includes("риск")) {
      return [
        "Возможные потери по тестовым данным:",
        "",
        "- зависшие товары замораживают деньги;",
        "- низкие остатки аксессуаров уменьшают допродажи;",
        "- расхождение кассы требует проверки в день закрытия;",
        "- незавершенные карточки не попадают в продажу вовремя."
      ].join("\n");
    }

    if (q.includes("авито")) {
      return [
        "Для Авито в карточке товара нужно собрать:",
        "",
        "- название;",
        "- категория;",
        "- цена;",
        "- фото;",
        "- описание;",
        "- комплектация;",
        "- состояние;",
        "- остаток;",
        "- город и контакт.",
        "",
        "Открой “Авито”, чтобы посмотреть профиль магазина и список публикаций. Для подготовки новой карточки перейди в “Товары” и нажми “Загрузить” у нужной позиции."
      ].join("\n");
    }

    if (q.includes("описан") || q.includes("telegram")) {
      return createContentText().telegram;
    }

    if (q.includes("фото") || q.includes("публикац") || q.includes("загруз")) {
      return [
        "По карточке товара сейчас можно:",
        "",
        "- загрузить фото локально и посмотреть предпросмотр;",
        "- сформировать текст для сайта, Telegram и объявления;",
        "- подготовить черновик карточки сайта;",
        "- добавить карточку в демо-очередь публикации.",
        "",
        "Для настоящей загрузки на сайт понадобится доступ к админке, API или техническая интеграция с CMS."
      ].join("\n");
    }

    if (q.includes("сайт") || q.includes("imagnate") || q.includes("каталог")) {
      return [
        "По публичному сайту можно подтягивать структуру разделов, категории, акции и статьи.",
        "",
        "Для реальных цен, остатков и карточек лучше получить доступ к CRM/API или выгрузку CSV/XLSX, чтобы не ломать сайт частыми запросами."
      ].join("\n");
    }

    return [
      "Я пока работаю на тестовых данных, но могу помочь с такими запросами:",
      "",
      "- что сегодня требует внимания;",
      "- какие товары залежались;",
      "- сделать отчет для владельца;",
      "- сформировать задачи сотрудникам;",
      "- подсказать, что продвигать;",
      "- оценить вариант импорта сайта."
    ].join("\n");
  }

  async function getAssistantResponse(prompt) {
    return assistantAnswer(prompt);
  }

  async function askAssistant(prompt) {
    chatHistory.push({ role: "user", title: "Вы", body: prompt });
    renderChat();

    const answer = await getAssistantResponse(prompt);
    chatHistory.push({ role: "assistant", title: "Ассистент", body: answer });
    saveChat();
    renderChat();
  }

  function sendChat(promptValue) {
    const input = byId("chatInput");
    const prompt = (promptValue || input?.value || "").trim();
    if (!prompt) return;

    if (input) input.value = "";
    askAssistant(prompt);
  }

  function sendFloatingChat(promptValue) {
    const input = byId("floatingChatInput");
    const prompt = (promptValue || input?.value || "").trim();
    if (!prompt) return;

    if (input) input.value = "";
    openFloatingAssistant();
    askAssistant(prompt);
  }

  function resetAssistantChat() {
    chatHistory = defaultChat.map((message) => ({ ...message }));
    saveChat();
    renderChat();
    showToast("Диалог очищен");
  }

  function createContentText() {
    const name = getFieldText("productName", "iPhone 15 Pro");
    const memory = getFieldText("productMemory", "256 GB");
    const color = getFieldText("productColor", "Natural Titanium");
    const price = getFieldNumber("productPrice", 123900);
    const condition = getFieldText("productCondition", "отличное");
    const warranty = getFieldText("productWarranty", "14 дней");
    const kit = getFieldText("productKit", "Коробка, кабель, чек магазина. Аккумулятор 91%, Face ID работает.");
    const fullName = `${name} ${memory}${color ? `, ${color}` : ""}`;

    const site = [
      `${fullName}`,
      "",
      `Состояние: ${condition}. Устройство проверено перед продажей, основные функции работают корректно.`,
      kit ? `Комплектация: ${kit}` : "",
      `Гарантия магазина: ${warranty}.`,
      `Цена: ${money(price)}.`
    ].filter(Boolean).join("\n");

    const telegram = [
      `${fullName} в наличии`,
      "",
      `Состояние: ${condition}`,
      kit ? `Комплект: ${kit}` : "",
      `Гарантия: ${warranty}`,
      `Цена: ${money(price)}`,
      "",
      "Можно забронировать и посмотреть в магазине."
    ].filter(Boolean).join("\n");

    const marketplace = [
      `${name} ${memory} ${color}`.trim(),
      "",
      `Продается ${fullName}. Состояние: ${condition}.`,
      kit,
      `Перед продажей устройство проверено. Гарантия магазина: ${warranty}.`,
      "Подойдет тем, кто хочет купить технику с проверкой и понятной историей."
    ].filter(Boolean).join("\n");

    return { site, telegram, marketplace };
  }

  function getProductCardData() {
    const content = createContentText();
    const name = getFieldText("productName", "iPhone 15 Pro");
    const memory = getFieldText("productMemory", "256 GB");
    const color = getFieldText("productColor", "Natural Titanium");
    const price = getFieldNumber("productPrice", 123900);
    const condition = getFieldText("productCondition", "отличное");
    const warranty = getFieldText("productWarranty", "14 дней");
    const kit = getFieldText("productKit", "");
    const slug = `${name}-${memory}-${color}`
      .toLowerCase()
      .replace(/[^a-zа-я0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "");

    return {
      title: `${name} ${memory}${color ? ` ${color}` : ""}`.trim(),
      slug,
      price,
      condition,
      warranty,
      kit,
      description: content.site,
      photos: productPhotos.map((photo) => ({
        name: photo.name,
        size: photo.size,
        type: photo.type
      })),
      status: "draft",
      preparedAt: new Date().toLocaleString("ru-RU")
    };
  }

  function renderPhotoPreview() {
    const target = byId("photoPreviewGrid");
    if (!target) return;

    if (!productPhotos.length) {
      target.innerHTML = `<div class="photo-empty">Фото пока не выбраны.</div>`;
      return;
    }

    target.innerHTML = productPhotos.map((photo, index) => `
      <article class="photo-preview">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name)}">
        <div class="photo-meta">
          <strong>${escapeHtml(photo.name)}</strong>
          <span>${Math.max(1, Math.round(photo.size / 1024))} КБ</span>
        </div>
        <button class="icon-btn" type="button" data-remove-photo="${index}" aria-label="Удалить фото">X</button>
      </article>
    `).join("");

    document.querySelectorAll("[data-remove-photo]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.removePhoto);
        productPhotos.splice(index, 1);
        renderPhotoPreview();
        renderSitePayload();
        renderSitePublishPhotos();
      });
    });
  }

  function renderSitePublishPhotos() {
    const target = byId("sitePublishPhotos");
    if (!target) return;

    if (!productPhotos.length) {
      target.innerHTML = `
        <div class="photo-empty">
          Фото для карточки сайта пока не выбраны.
        </div>
      `;
      return;
    }

    target.innerHTML = productPhotos.map((photo, index) => `
      <article class="publish-photo">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.name)}">
        <div class="photo-meta">
          <strong>Фото ${index + 1}</strong>
          <span>${escapeHtml(photo.name)} · ${Math.max(1, Math.round(photo.size / 1024))} КБ</span>
        </div>
      </article>
    `).join("");
  }

  function handlePhotoUpload(event) {
    const files = Array.from(event.target.files || []);
    productPhotos.forEach((photo) => URL.revokeObjectURL(photo.url));
    productPhotos = files.map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      url: URL.createObjectURL(file)
    }));
    renderPhotoPreview();
    renderSitePayload();
    renderSitePublishPhotos();
  }

  function renderSitePayload() {
    const target = byId("sitePublishPayload");
    if (!target) return;

    const card = getProductCardData();
    target.textContent = [
      "Черновик карточки для сайта:",
      "",
      `Название: ${card.title}`,
      `URL-slug: ${card.slug || "будет создан автоматически"}`,
      `Цена: ${money(card.price)}`,
      `Состояние: ${card.condition}`,
      `Гарантия: ${card.warranty}`,
      `Фото: ${card.photos.length ? card.photos.map((photo) => photo.name).join(", ") : "не выбраны"}`,
      "",
      "Что уйдет в будущую интеграцию:",
      "- название товара;",
      "- цена;",
      "- описание;",
      "- характеристики;",
      "- фотографии;",
      "- статус публикации."
    ].join("\n");
  }

  function prepareSiteCard() {
    renderContent();
    renderSitePayload();
    showToast("Карточка сайта подготовлена");
  }

  function publishToSite() {
    const card = getProductCardData();
    if (!card.title || !card.price) {
      showToast("Заполните название и цену");
      return;
    }

    const publication = {
      id: Date.now(),
      title: card.title,
      price: card.price,
      photosCount: card.photos.length,
      status: "Отправлено в демо-очередь",
      createdAt: new Date().toLocaleString("ru-RU")
    };
    sitePublications.unshift(publication);
    saveSitePublications();
    renderSitePublishHistory();
    renderSitePayload();
    showToast("Карточка добавлена в демо-очередь сайта");
  }

  function renderSitePublishHistory() {
    const target = byId("sitePublishHistory");
    if (!target) return;

    if (!sitePublications.length) {
      target.innerHTML = `
        <article class="activity-item">
          <div class="attention-title">Публикаций пока нет</div>
          <div class="activity-meta">После нажатия “Загрузить на сайт” здесь появится демо-история.</div>
        </article>
      `;
      return;
    }

    target.innerHTML = sitePublications.slice(0, 5).map((item) => `
      <article class="activity-item">
        <div class="panel-header">
          <div>
            <div class="attention-title">${escapeHtml(item.title)}</div>
            <div class="activity-meta">${money(item.price)} · фото: ${item.photosCount} · ${escapeHtml(item.createdAt)}</div>
          </div>
          <span class="status-pill blue">${escapeHtml(item.status)}</span>
        </div>
      </article>
    `).join("");
  }

  function renderContent() {
    const target = byId("contentResult");
    if (!target) return;

    const content = createContentText();
    target.innerHTML = [
      ["site", "Текст для сайта", content.site],
      ["telegram", "Текст для Telegram", content.telegram],
      ["marketplace", "Текст для объявления", content.marketplace]
    ].map(([type, title, text]) => `
      <article class="generator-result">
        <div class="panel-header">
          <h3>${title}</h3>
          <button class="ghost-btn" type="button" data-copy-type="${type}">Скопировать</button>
        </div>
        <div class="result-text">${escapeHtml(text)}</div>
      </article>
    `).join("");

    document.querySelectorAll("[data-copy-type]").forEach((button) => {
      button.addEventListener("click", () => {
        const freshContent = createContentText();
        copyText(freshContent[button.dataset.copyType]);
      });
    });

    renderPhotoPreview();
    renderSitePayload();
    renderSitePublishPhotos();
    renderSitePublishHistory();
  }

  function renderShift() {
    const result = byId("shiftResult");
    const report = byId("shiftReport");
    if (!result || !report) return;

    const values = getShiftValues();
    result.innerHTML = `
      <div class="mini-card">
        <span class="metric-label">Ожидаемый остаток</span>
        <strong>${money(values.expected)}</strong>
      </div>
      <div class="mini-card">
        <span class="metric-label">Фактический остаток</span>
        <strong>${money(values.cashActual)}</strong>
      </div>
      <div class="mini-card">
        <span class="metric-label">Расхождение</span>
        <strong class="${values.difference === 0 ? "money-positive" : "money-negative"}">${money(values.difference)}</strong>
      </div>
    `;

    const comment = getFieldText("shiftComment", seed.shift?.comment);
    report.textContent = [
      "Отчет по закрытию смены",
      "",
      `Выручка: ${money(values.totalRevenue)}.`,
      `Наличные на начало: ${money(values.cashStart)}.`,
      `Продажи наличными: ${money(values.cashSales)}.`,
      `Оплаты картой: ${money(values.cardSales)}.`,
      `Переводы: ${money(values.transfers)}.`,
      `Расходы: ${money(values.expenses)}.`,
      `Инкассация: ${money(values.collection)}.`,
      `Ожидаемый остаток: ${money(values.expected)}.`,
      `Фактический остаток: ${money(values.cashActual)}.`,
      `Расхождение: ${money(values.difference)}.`,
      comment ? `Комментарий: ${comment}` : ""
    ].filter(Boolean).join("\n");
  }

  function getAvitoCategory(category) {
    const map = {
      "Смартфоны": "Бытовая электроника / Телефоны",
      "Аксессуары": "Бытовая электроника / Аксессуары",
      "Игровые приставки": "Бытовая электроника / Игровые приставки",
      "Аудио": "Бытовая электроника / Аудио",
      "Планшеты": "Бытовая электроника / Планшеты",
      "Ноутбуки": "Бытовая электроника / Ноутбуки",
      "Ремонт": "Услуги / Ремонт техники"
    };
    return map[category] || "Бытовая электроника";
  }

  function shortenAvitoTitle(title) {
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
    return cleanTitle.length > 50 ? `${cleanTitle.slice(0, 47).trim()}...` : cleanTitle;
  }

  function getAvitoProduct() {
    return Number.isInteger(activeAvitoProductIndex) ? products[activeAvitoProductIndex] : null;
  }

  function getAvitoPhotos(product) {
    if (!product) return [];
    return avitoPhotosBySku[product.sku] || [];
  }

  function getAvitoPhotoUrls(product = getAvitoProduct()) {
    const fromField = getFieldText("avitoPhotoUrls", "")
      .split(/\n|;|,/)
      .map((url) => url.trim())
      .filter(Boolean);
    if (fromField.length) return fromField;
    if (product?.photoUrls?.length) return product.photoUrls;
    return getAvitoPhotos(product).map((photo) => photo.url || photo.dataUrl).filter((url) => /^https?:\/\//i.test(url));
  }

  function getAvitoPayload() {
    const product = getAvitoProduct();
    if (!product) return null;

    const photos = getAvitoPhotos(product);
    const photoUrls = getAvitoPhotoUrls(product);
    return {
      product,
      title: shortenAvitoTitle(product.name),
      price: getFieldNumber("avitoPrice", product.price),
      category: getFieldText("avitoCategory", getAvitoCategory(product.category)),
      condition: getFieldText("avitoCondition", product.condition || "Отличное"),
      city: getFieldText("avitoCity", store.city || ""),
      contact: getFieldText("avitoContact", store.phone || ""),
      kit: getFieldText("avitoKit", product.kit || ""),
      description: getFieldText("avitoDescription", product.description || product.comment || ""),
      photoSource: getFieldText("avitoPhotoSource", product.photoSource || (product.photoUrls?.length ? "site" : "own")),
      photos,
      photoUrls,
      existingPhotosCount: Number(product.photosCount || 0)
    };
  }

  function getAvitoPhotoSourceLabel(source) {
    const labels = {
      own: "Живые фото конкретного товара",
      site: "Фото с сайта магазина",
      supplier: "Каталожные фото поставщика",
      mixed: "Смешанный набор"
    };
    return labels[source] || labels.own;
  }

  function hasCatalogLikePhotoName(value) {
    const text = String(value || "").toLowerCase();
    return ["logo", "watermark", "banner", "catalog", "template", "background", "cover", "screenshot", "screen", "landscape", "supplier"].some((part) => text.includes(part));
  }

  function hasExternalContactInDescription(description) {
    const text = String(description || "");
    return /(https?:\/\/|www\.|telegram|whatsapp|wa\.me|t\.me|@[a-z0-9_]{3,}|\+?\d[\d\s()\-]{8,}\d)/i.test(text);
  }

  function getAvitoModerationReport(payload) {
    const items = [];
    let score = 100;

    const add = (level, title, text, points = 0) => {
      items.push({ level, title, text });
      score -= points;
    };

    if (!payload) {
      return {
        status: "Не готово",
        score: 0,
        statusClass: "danger",
        items: [{ level: "danger", title: "Товар не выбран", text: "Открой карточку товара и заполни данные для Авито." }]
      };
    }

    const photoCount = Math.max(payload.photos.length, payload.photoUrls.length, payload.existingPhotosCount || 0);
    const siteUrls = payload.photoUrls.filter((url) => /imagnate\.ru|site\.ru|cdn|static|catalog/i.test(url));
    const badNames = payload.photos.filter((photo) => hasCatalogLikePhotoName(photo.name));
    const smallPhotos = payload.photos.filter((photo) => photo.width && photo.height && (photo.width < 800 || photo.height < 600));
    const hugePhotos = payload.photos.filter((photo) => Number(photo.size || 0) > 25 * 1024 * 1024);
    const nonSecureUrls = payload.photoUrls.filter((url) => !/^https:\/\//i.test(url));

    if (!photoCount) {
      add("danger", "Нет фото", "Для публикации нужны реальные фотографии товара. Без них карточку почти наверняка придется дорабатывать.", 35);
    } else if (photoCount < 3) {
      add("warn", "Мало фото", "Лучше добавить 3-5 фото: общий вид, экран, корпус, торцы, комплект и заметные нюансы.", 12);
    } else {
      add("pass", "Фото есть", "Количество фото выглядит нормально для первичной публикации.", 0);
    }

    if (payload.photoSource === "site" || siteUrls.length) {
      add("warn", "Фото взяты с сайта", "Для Авито лучше добавить живые уникальные фото конкретного экземпляра. Фото с сайта могут выглядеть как повторные или каталожные.", 18);
    }

    if (payload.photoSource === "supplier") {
      add("danger", "Каталожные фото", "Каталожные или поставщицкие фото лучше не отправлять без живых снимков товара. Это высокий риск отклонения или низкого доверия.", 30);
    }

    if (payload.photoSource === "mixed") {
      add("warn", "Смешанные фото", "Проверь, чтобы первой стояла живая фотография товара, а не картинка с сайта или поставщика.", 8);
    }

    if (badNames.length) {
      add("warn", "Подозрительные имена файлов", `Проверь файлы: ${badNames.map((photo) => photo.name).join(", ")}. Названия похожи на баннер, скриншот или шаблон.`, 10);
    }

    if (smallPhotos.length) {
      add("warn", "Низкое разрешение", "Часть фото меньше 800x600. Лучше заменить на более четкие снимки.", 10);
    }

    if (hugePhotos.length) {
      add("warn", "Слишком тяжелые фото", "Часть файлов тяжелее 25 МБ. Перед выгрузкой лучше сжать их.", 10);
    }

    if (nonSecureUrls.length) {
      add("warn", "Фото-ссылки без HTTPS", "Для XML лучше использовать прямые HTTPS-ссылки на изображения.", 8);
    }

    if (payload.photos.length && !payload.photoUrls.length) {
      add("warn", "Нет публичных ссылок для XML", "Для ручной загрузки фото подходят, но для XML/API нужны публичные ссылки на изображения.", 8);
    }

    if (!payload.photos.length && !payload.photoUrls.length && payload.existingPhotosCount) {
      add("warn", "Фото есть только как счетчик", "В товаре указано количество фото, но сами файлы или ссылки не прикреплены к выгрузке. Для реальной отправки нужны файлы или публичные URL.", 10);
    }

    if (!payload.price || payload.price <= 0) {
      add("danger", "Нет цены", "Цена обязательна для публикации.", 20);
    }

    if (!payload.description || payload.description.trim().length < 80) {
      add("warn", "Короткое описание", "Добавь состояние, гарантию, комплектацию, нюансы и что клиент может проверить при покупке.", 12);
    }

    if (hasExternalContactInDescription(payload.description)) {
      add("warn", "Контакты в описании", "Ссылки, мессенджеры и телефоны лучше держать в разрешенных полях площадки, а не в тексте описания.", 12);
    }

    if (!payload.kit) {
      add("warn", "Не указана комплектация", "Для техники лучше явно указать коробку, кабель, чек, гарантию и состояние АКБ, если это телефон.", 8);
    }

    if (payload.condition === "Требует проверки") {
      add("warn", "Слабый статус состояния", "Для объявления лучше указать понятное состояние и отдельно описать нюансы.", 8);
    }

    if (!items.some((item) => item.level !== "pass")) {
      add("pass", "Карточка выглядит чисто", "Можно готовить выгрузку. Перед реальной публикацией все равно стоит открыть предпросмотр Авито.", 0);
    }

    const hasDanger = items.some((item) => item.level === "danger");
    const hasWarn = items.some((item) => item.level === "warn");
    const normalizedScore = Math.max(0, Math.min(100, score));
    return {
      status: hasDanger ? "Высокий риск" : hasWarn ? "Нужно проверить" : "Готово",
      score: normalizedScore,
      statusClass: hasDanger ? "danger" : hasWarn ? "warning" : "blue",
      items
    };
  }

  function getAvitoPayloadText(payload) {
    if (!payload) return "";
    const report = getAvitoModerationReport(payload);
    return [
      `Название: ${payload.title}`,
      `Категория: ${payload.category}`,
      `Цена: ${money(payload.price)}`,
      `Состояние: ${payload.condition}`,
      `Город: ${payload.city}`,
      `Контакт: ${payload.contact}`,
      `Комплектация: ${payload.kit || "не указана"}`,
      `Источник фото: ${getAvitoPhotoSourceLabel(payload.photoSource)}`,
      `Фото: ${payload.photos.length ? payload.photos.map((photo) => photo.name).join(", ") : "не прикреплены"}`,
      `Фото в карточке: ${payload.existingPhotosCount || 0}`,
      `Фото URL для XML: ${payload.photoUrls.length ? payload.photoUrls.join(", ") : "не указаны"}`,
      `Предпроверка: ${report.status} (${report.score}/100)`,
      "",
      "Описание:",
      payload.description || "Описание не заполнено."
    ].join("\n");
  }

  function openAvitoModal(index) {
    const product = products[index];
    const modal = byId("avitoModal");
    if (!product || !modal) return;

    activeAvitoProductIndex = index;
    byId("avitoSelectedProduct").innerHTML = `
      <strong>${escapeHtml(product.name)}</strong>
      <span>${escapeHtml(product.sku || "без SKU")} · ${escapeHtml(product.category)} · остаток: ${product.stock} шт.</span>
    `;
    byId("avitoPrice").value = product.price || "";
    byId("avitoCategory").value = getAvitoCategory(product.category);
    byId("avitoCondition").value = product.condition || "Отличное";
    byId("avitoCity").value = store.city || "";
    byId("avitoContact").value = store.phone || "";
    byId("avitoKit").value = product.kit || "";
    byId("avitoDescription").value = product.description || product.comment || "";
    byId("avitoPhotoUrls").value = (product.photoUrls || []).join("\n");
    byId("avitoPhotoSource").value = product.photoSource || (product.photoUrls?.length ? "site" : "own");
    byId("avitoPhotos").value = "";

    renderAvitoPhotoPreview();
    renderAvitoPayloadPreview();
    modal.hidden = false;
    byId("avitoPhotos").focus();
  }

  function closeAvitoModal() {
    const modal = byId("avitoModal");
    if (modal) modal.hidden = true;
  }

  function fileToAvitoPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const image = new Image();
        image.onload = () => resolve({
          name: file.name,
          size: file.size,
          type: file.type,
          width: image.naturalWidth,
          height: image.naturalHeight,
          dataUrl
        });
        image.onerror = () => resolve({
          name: file.name,
          size: file.size,
          type: file.type,
          dataUrl
        });
        image.src = dataUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleAvitoPhotoUpload(event) {
    const product = getAvitoProduct();
    if (!product) return;

    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const photos = await Promise.all(files.map(fileToAvitoPhoto));
    avitoPhotosBySku[product.sku] = photos;
    product.photosCount = photos.length;
    saveAvitoPhotos();
    saveProducts();
    renderAvitoPhotoPreview();
    renderAvitoPayloadPreview();
    renderProducts();
    showToast(`Фото прикреплены: ${photos.length}`);
  }

  function renderAvitoPhotoPreview() {
    const target = byId("avitoPhotoPreview");
    const product = getAvitoProduct();
    if (!target || !product) return;

    const photos = getAvitoPhotos(product);
    if (!photos.length) {
      target.innerHTML = `
        <div class="photo-empty">
          Фото пока не прикреплены. Для Авито лучше добавить 3-5 реальных фото товара.
        </div>
      `;
      return;
    }

    target.innerHTML = photos.map((photo, index) => `
      <article class="photo-preview">
        <button class="icon-btn" type="button" data-avito-photo-remove="${index}" aria-label="Удалить фото">X</button>
        <img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photo.name)}">
        <div class="photo-meta">
          <strong>Фото ${index + 1}</strong>
          <span>${escapeHtml(photo.name)} · ${Math.max(1, Math.round(photo.size / 1024))} КБ</span>
        </div>
      </article>
    `).join("");

    document.querySelectorAll("[data-avito-photo-remove]").forEach((button) => {
      button.addEventListener("click", () => removeAvitoPhoto(Number(button.dataset.avitoPhotoRemove)));
    });
  }

  function removeAvitoPhoto(index) {
    const product = getAvitoProduct();
    if (!product) return;

    const photos = getAvitoPhotos(product).filter((_, photoIndex) => photoIndex !== index);
    avitoPhotosBySku[product.sku] = photos;
    product.photosCount = photos.length;
    saveAvitoPhotos();
    saveProducts();
    renderAvitoPhotoPreview();
    renderAvitoPayloadPreview();
    renderProducts();
  }

  function renderAvitoPayloadPreview() {
    const target = byId("avitoPayloadPreview");
    const payload = getAvitoPayload();
    if (target) target.textContent = getAvitoPayloadText(payload);
    renderAvitoModerationReport(payload);
  }

  function renderAvitoModerationReport(payload) {
    const target = byId("avitoModerationBox");
    if (!target) return;

    const report = getAvitoModerationReport(payload);
    target.innerHTML = `
      <div class="moderation-head">
        <div class="moderation-title">
          <strong>Предпроверка модерации</strong>
          <span>Оценка не гарантирует публикацию, но заранее показывает слабые места карточки.</span>
        </div>
        <span class="status-pill ${report.statusClass}">${escapeHtml(report.status)} · ${report.score}/100</span>
      </div>
      <div class="moderation-list">
        ${report.items.slice(0, 6).map((item) => `
          <div class="moderation-item ${item.level}">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.text)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function validateAvitoPayload(payload) {
    if (!payload) return "Выберите товар";
    if (!payload.photos.length && !payload.photoUrls.length) return "Прикрепите фото или укажите ссылки";
    if (!payload.price) return "Укажите цену";
    if (!payload.description || payload.description.length < 20) return "Добавьте описание товара";
    if (!payload.kit) return "Укажите комплектацию";
    if (!payload.city || !payload.contact) return "Укажите город и контакт";
    return "";
  }

  function submitAvitoListing() {
    const payload = getAvitoPayload();
    const error = validateAvitoPayload(payload);
    if (error) {
      showToast(error);
      return;
    }

    const report = getAvitoModerationReport(payload);
    payload.product.avitoStatus = report.status === "Готово" ? "Готово к Авито" : "Нужна проверка Авито";
    payload.product.avitoModeration = report.status;
    payload.product.avitoModerationScore = report.score;
    payload.product.price = payload.price;
    payload.product.condition = payload.condition;
    payload.product.kit = payload.kit;
    payload.product.description = payload.description;
    payload.product.photosCount = Math.max(payload.photos.length, payload.photoUrls.length, payload.existingPhotosCount || 0);
    payload.product.photoUrls = payload.photoUrls;
    payload.product.photoSource = payload.photoSource;

    avitoDrafts.unshift({
      id: Date.now(),
      sku: payload.product.sku,
      title: payload.title,
      price: payload.price,
      photosCount: Math.max(payload.photos.length, payload.photoUrls.length, payload.existingPhotosCount || 0),
      status: payload.product.avitoStatus,
      moderationStatus: report.status,
      moderationScore: report.score,
      createdAt: new Date().toLocaleString("ru-RU")
    });

    saveProducts();
    saveAvitoDrafts();
    renderProducts();
    closeAvitoModal();
    showToast("Карточка подготовлена для Авито");
  }

  function copyAvitoPayload() {
    const payload = getAvitoPayload();
    copyText(getAvitoPayloadText(payload));
  }

  function getAvitoProfileUrl() {
    return store.avitoProfileUrl || "https://www.avito.ru/user/45b3050882d7589ba21bf140dde5c6f8/profile?src=sharing";
  }

  function getProductPhotoCount(product) {
    return Math.max(Number(product.photosCount || 0), getAvitoPhotos(product).length, product.photoUrls?.length || 0);
  }

  function renderAvitoOverview() {
    const metricsTarget = byId("avitoMetrics");
    const profileLink = byId("openAvitoProfile");
    const profileUrlText = byId("avitoProfileUrl");
    if (!metricsTarget && !profileLink && !profileUrlText) return;

    const profileUrl = getAvitoProfileUrl();
    const preparedProducts = products.filter((product) => product.avitoStatus);
    const productsWithPhotos = products.filter((product) => getProductPhotoCount(product) > 0);
    const readyProducts = products.filter((product) => product.price > 0 && product.stock > 0 && (product.description || product.comment));

    if (profileLink) profileLink.href = profileUrl;
    if (profileUrlText) profileUrlText.textContent = profileUrl;

    if (metricsTarget) {
      const metrics = [
        { label: "Профиль Авито", value: "Подключен", context: "Публичная ссылка магазина" },
        { label: "Готово к Авито", value: String(preparedProducts.length), context: "Карточки с демо-статусом" },
        { label: "С фото", value: String(productsWithPhotos.length), context: "Есть фото или ссылки" },
        { label: "Можно готовить", value: String(readyProducts.length), context: "Цена, остаток и описание", attention: true }
      ];

      metricsTarget.innerHTML = metrics.map((item) => `
        <article class="metric-card ${item.attention ? "attention" : ""}">
          <div class="metric-label">${item.label}</div>
          <div class="metric-value">${item.value}</div>
          <div class="metric-context">${item.context}</div>
        </article>
      `).join("");
    }

    renderAvitoPreparedList();
    renderAvitoIntegrationList();
    renderAvitoProductsTable();
  }

  function renderAvitoPreparedList() {
    const target = byId("avitoPreparedList");
    if (!target) return;

    if (!avitoDrafts.length) {
      target.innerHTML = `
        <article class="activity-item">
          <div class="attention-title">Подготовленных карточек пока нет</div>
          <div class="activity-meta">Открой “Товары”, нажми “Загрузить” в колонке Авито и подготовь карточку.</div>
        </article>
      `;
      return;
    }

    target.innerHTML = avitoDrafts.slice(0, 6).map((item) => `
      <article class="activity-item">
        <div class="panel-header">
          <div>
            <div class="attention-title">${escapeHtml(item.title)}</div>
            <div class="activity-meta">${money(item.price)} · фото: ${item.photosCount} · модерация: ${escapeHtml(item.moderationStatus || "не проверено")} · ${escapeHtml(item.createdAt)}</div>
          </div>
          <span class="status-pill blue">${escapeHtml(item.status)}</span>
        </div>
      </article>
    `).join("");
  }

  function renderAvitoIntegrationList() {
    const target = byId("avitoIntegrationList");
    if (!target) return;

    const items = [
      {
        pill: "Готово",
        title: "Публичный профиль магазина",
        meta: "Сотрудники могут открыть витрину Авито из ассистента и сверить объявления."
      },
      {
        pill: "Готово",
        title: "XML/JSON подготовка карточек",
        meta: "В товаре можно заполнить фото, описание, комплектацию и скачать XML или JSON."
      },
      {
        pill: "Готово",
        title: "Предпроверка модерации",
        meta: "Ассистент заранее подсвечивает риски: фото с сайта, мало фото, каталожные изображения, короткое описание и контакты в тексте."
      },
      {
        pill: "Нужен доступ",
        title: "Официальный API Авито",
        meta: "Для настоящей синхронизации нужны доступы Авито: приложение, токены, права на объявления и профиль магазина.",
        warning: true
      },
      {
        pill: "Следующий шаг",
        title: "Сообщения и статистика",
        meta: "После API можно подтягивать просмотры, обращения, статусы модерации и диалоги клиентов."
      }
    ];

    target.innerHTML = items.map((item) => `
      <article class="attention-item">
        <span class="status-pill ${item.warning ? "warning" : ""}">${escapeHtml(item.pill)}</span>
        <div class="attention-title">${escapeHtml(item.title)}</div>
        <div class="attention-meta">${escapeHtml(item.meta)}</div>
      </article>
    `).join("");
  }

  function renderAvitoProductsTable() {
    const target = byId("avitoProductsTable");
    const counter = byId("avitoProductsCount");
    if (!target) return;
    if (counter) counter.textContent = `${products.length} товаров`;

    target.innerHTML = products.map((product) => {
      const photos = getProductPhotoCount(product);
      const status = product.avitoStatus || (product.price > 0 && product.stock > 0 ? "Нужно подготовить" : "Не готово");
      const statusClass = product.avitoStatus ? "blue" : product.price > 0 && product.stock > 0 ? "warning" : "danger";
      const moderation = product.avitoModeration ? `${product.avitoModeration} · ${product.avitoModerationScore}/100` : "не проверено";
      return `
        <tr>
          <td><strong>${escapeHtml(product.name)}</strong><div class="activity-meta">${escapeHtml(product.sku || "")}</div></td>
          <td>${money(product.price)}</td>
          <td>${product.stock} шт.</td>
          <td>${photos ? `${photos} фото` : "нет фото"}</td>
          <td><span class="status-pill ${statusClass}">${escapeHtml(status)}</span><div class="activity-meta">${escapeHtml(moderation)}</div></td>
          <td><a class="ghost-btn compact-btn" href="inventory.html">Подготовить</a></td>
        </tr>
      `;
    }).join("");
  }

  function copyAvitoProfileUrl() {
    copyText(getAvitoProfileUrl());
  }

  function getAvitoXml(payload) {
    const imageUrls = payload.photoUrls.length
      ? payload.photoUrls
      : payload.photos.map((photo, index) => `https://example.com/photos/${encodeURIComponent(payload.product.sku)}-${index + 1}.jpg`);
    const cdataDescription = `${payload.description}\n\nКомплектация: ${payload.kit}\nСостояние: ${payload.condition}`.replaceAll("]]>", "]]]]><![CDATA[>");

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Ads formatVersion="3" target="Avito.ru">',
      '  <Ad>',
      `    <Id>${escapeXml(payload.product.sku)}</Id>`,
      `    <Title>${escapeXml(payload.title)}</Title>`,
      `    <Category>${escapeXml(payload.category)}</Category>`,
      `    <Description><![CDATA[${cdataDescription}]]></Description>`,
      `    <Price>${Math.round(Number(payload.price || 0))}</Price>`,
      `    <Address>${escapeXml(payload.city)}</Address>`,
      `    <Condition>${escapeXml(payload.condition)}</Condition>`,
      '    <Images>',
      ...imageUrls.map((url) => `      <Image url="${escapeXml(url)}" />`),
      '    </Images>',
      '  </Ad>',
      '</Ads>'
    ].join("\n");
  }

  function downloadAvitoXml() {
    const payload = getAvitoPayload();
    const error = validateAvitoPayload(payload);
    if (error) {
      showToast(error);
      return;
    }
    if (!payload.photoUrls.length) {
      showToast("XML скачан с примерными ссылками на фото");
    }
    downloadTextFile(`avito-${payload.product.sku}.xml`, getAvitoXml(payload), "application/xml;charset=utf-8");
  }

  function downloadAvitoJson() {
    const payload = getAvitoPayload();
    const error = validateAvitoPayload(payload);
    if (error) {
      showToast(error);
      return;
    }
    const report = getAvitoModerationReport(payload);
    const json = {
      externalId: payload.product.sku,
      title: payload.title,
      category: payload.category,
      price: payload.price,
      condition: payload.condition,
      city: payload.city,
      contact: payload.contact,
      kit: payload.kit,
      description: payload.description,
      photoSource: payload.photoSource,
      existingPhotosCount: payload.existingPhotosCount,
      photoUrls: payload.photoUrls,
      localPhotos: payload.photos.map((photo) => ({ name: photo.name, size: photo.size, type: photo.type, width: photo.width, height: photo.height })),
      moderation: {
        status: report.status,
        score: report.score,
        issues: report.items.filter((item) => item.level !== "pass")
      }
    };
    downloadTextFile(`avito-${payload.product.sku}.json`, JSON.stringify(json, null, 2), "application/json;charset=utf-8");
  }

  function renderProducts() {
    const target = byId("productsTable");
    if (!target) return;

    const filter = byId("inventoryFilter")?.value || "all";
    const search = (byId("inventorySearch")?.value || "").trim().toLowerCase();
    let visible = products;
    if (filter === "attention") visible = products.filter((product) => product.days >= 30 || product.stock <= 2 || product.status === "На диагностике");
    if (filter === "published") visible = products.filter((product) => product.status === "Опубликован");
    if (filter === "stock") visible = products.filter((product) => product.category === "Аксессуары");
    if (filter === "empty") visible = products.filter((product) => product.stock <= 0);
    if (search) {
      visible = visible.filter((product) => {
        const haystack = [product.name, product.sku, product.category, product.status, product.comment].join(" ").toLowerCase();
        return haystack.includes(search);
      });
    }

    if (!visible.length) {
      target.innerHTML = `
        <tr>
          <td colspan="9">По текущему фильтру товаров нет.</td>
        </tr>
      `;
      return;
    }

    target.innerHTML = visible.map((product) => {
      const index = products.indexOf(product);
      const margin = product.price - product.cost;
      const pillClass = product.days >= 30 || product.stock <= 2 ? "warning" : product.status === "На диагностике" ? "blue" : "";
      const stockClass = product.stock <= 0 ? "danger" : product.stock <= 2 ? "warning" : "";
      return `
        <tr>
          <td><strong>${escapeHtml(product.name)}</strong><div class="activity-meta">${escapeHtml(product.sku || "")}</div></td>
          <td>${escapeHtml(product.category)}</td>
          <td><span class="status-pill ${pillClass}">${escapeHtml(product.status)}</span></td>
          <td>
            <span class="status-pill ${stockClass}">${product.stock} шт.</span>
            <div class="stock-actions">
              <button class="icon-btn" type="button" data-stock-dec="${index}" aria-label="Уменьшить остаток">−</button>
              <button class="icon-btn" type="button" data-stock-inc="${index}" aria-label="Увеличить остаток">+</button>
            </div>
          </td>
          <td>${product.days}</td>
          <td>${can("finance") ? money(product.cost * product.stock) : "Скрыто"}</td>
          <td>${can("finance") ? money(margin) : "Скрыто"}</td>
          <td>
            <div class="stock-actions">
              <button class="ghost-btn compact-btn" type="button" data-avito-open="${index}">Загрузить</button>
            </div>
            ${product.avitoStatus ? `<div class="activity-meta">${escapeHtml(product.avitoStatus)}</div>` : ""}
            ${product.avitoModeration ? `<div class="activity-meta">Проверка: ${escapeHtml(product.avitoModeration)} · ${product.avitoModerationScore}/100</div>` : ""}
          </td>
          <td>${escapeHtml(product.comment)}</td>
        </tr>
      `;
    }).join("");

    document.querySelectorAll("[data-stock-inc]").forEach((button) => {
      button.addEventListener("click", () => changeProductStock(Number(button.dataset.stockInc), 1));
    });
    document.querySelectorAll("[data-stock-dec]").forEach((button) => {
      button.addEventListener("click", () => changeProductStock(Number(button.dataset.stockDec), -1));
    });
    document.querySelectorAll("[data-avito-open]").forEach((button) => {
      button.addEventListener("click", () => openAvitoModal(Number(button.dataset.avitoOpen)));
    });
  }

  function changeProductStock(index, delta) {
    if (!products[index]) return;
    products[index].stock = Math.max(0, products[index].stock + delta);
    saveProducts();
    renderProducts();
    renderInventoryMetrics();
    renderAttention();
    renderDigest();
    renderMetrics();
    showToast(`Остаток обновлен: ${products[index].stock} шт.`);
  }

  function addProductFromForm(event) {
    event.preventDefault();

    const name = getFieldText("newProductName", "");
    if (!name) {
      showToast("Введите название товара");
      byId("newProductName")?.focus();
      return;
    }

    const product = normalizeProduct({
      sku: getFieldText("newProductSku", `SKU-${Date.now()}`),
      name,
      category: getFieldText("newProductCategory", "Без категории"),
      status: getFieldText("newProductStatus", "Остаток"),
      stock: getFieldNumber("newProductStock", 1),
      cost: getFieldNumber("newProductCost", 0),
      price: getFieldNumber("newProductPrice", 0),
      days: getFieldNumber("newProductDays", 0),
      source: "manual",
      comment: getFieldText("newProductComment", ""),
      condition: "Отличное",
      kit: "",
      description: getFieldText("newProductComment", ""),
      photosCount: 0,
      photoSource: "own",
      avitoStatus: ""
    });

    products.unshift(product);
    saveProducts();
    event.target.reset();
    if (byId("newProductStock")) byId("newProductStock").value = "1";
    if (byId("newProductDays")) byId("newProductDays").value = "0";
    renderProducts();
    renderInventoryMetrics();
    renderAttention();
    renderDigest();
    renderMetrics();
    showToast("Товар добавлен");
  }

  function resetInventoryProducts() {
    products = getSeedProducts();
    avitoDrafts = [];
    avitoPhotosBySku = {};
    activeAvitoProductIndex = null;
    saveProducts();
    saveAvitoDrafts();
    saveAvitoPhotos();
    renderProducts();
    renderInventoryMetrics();
    renderAttention();
    renderDigest();
    renderMetrics();
    showToast("Демо-товары сброшены");
  }

  function getValueByAliases(row, aliases, fallback = "") {
    const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase(), value]));
    for (const alias of aliases) {
      const value = normalized[alias.toLowerCase()];
      if (value !== undefined && value !== "") return value;
    }
    return fallback;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let insideQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];

      if (char === '"' && insideQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if ((char === "," || char === ";") && !insideQuotes) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !insideQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }

    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    if (rows.length < 2) return [];

    const headers = rows[0];
    return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  }

  function normalizeImportedProduct(row, index) {
    const price = Number(getValueByAliases(row, ["price", "salePrice", "sale_price", "цена", "цена продажи"], 0));
    const cost = Number(getValueByAliases(row, ["cost", "costPrice", "cost_price", "закупка", "себестоимость"], 0));
    const stock = Number(getValueByAliases(row, ["stock", "stockQty", "stock_qty", "остаток", "количество"], 1));
    const photoUrls = String(getValueByAliases(row, ["photoUrls", "photo_urls", "photos", "фото", "ссылки на фото"], ""))
      .split(/[;,\n]/)
      .map((url) => url.trim())
      .filter(Boolean);
    const photoSource = getValueByAliases(row, ["photoSource", "photo_source", "источник фото"], photoUrls.length ? "site" : "own");

    return normalizeProduct({
      sku: getValueByAliases(row, ["sku", "id", "article", "артикул", "imei"], `IMPORT-${Date.now()}-${index + 1}`),
      name: getValueByAliases(row, ["name", "title", "название", "товар"], "Новый товар"),
      category: getValueByAliases(row, ["category", "категория"], "Без категории"),
      status: getValueByAliases(row, ["status", "статус"], "Остаток"),
      stock,
      cost,
      price,
      days: Number(getValueByAliases(row, ["days", "daysInSale", "дней в продаже"], 0)),
      source: "import",
      comment: getValueByAliases(row, ["comment", "комментарий"], ""),
      condition: getValueByAliases(row, ["condition", "состояние"], "Отличное"),
      kit: getValueByAliases(row, ["kit", "комплектация"], ""),
      description: getValueByAliases(row, ["description", "описание"], ""),
      photosCount: photoUrls.length,
      photoUrls,
      photoSource,
      avitoStatus: ""
    });
  }

  function importProductsFromRows(rows) {
    const imported = rows.map(normalizeImportedProduct).filter((product) => product.name && product.sku);
    if (!imported.length) {
      showToast("В файле не найдены товары");
      return;
    }

    products = imported;
    avitoPhotosBySku = Object.fromEntries(imported
      .filter((product) => product.photoUrls.length)
      .map((product) => [product.sku, product.photoUrls.map((url, index) => ({
        name: `Фото по ссылке ${index + 1}`,
        size: 0,
        type: "url",
        dataUrl: url,
        url
      }))]));
    avitoDrafts = [];
    saveProducts();
    saveAvitoPhotos();
    saveAvitoDrafts();
    refreshAll();
    const result = byId("realDataImportResult");
    if (result) {
      result.textContent = [
        `Импортировано товаров: ${imported.length}.`,
        `Единиц на складе: ${getStockUnits()}.`,
        `Источник: файл владельца/CRM.`,
        "",
        "Теперь эти товары используются в разделе “Товары”, в AI-сводке и в подготовке Авито."
      ].join("\n");
    }
    showToast(`Импортировано товаров: ${imported.length}`);
  }

  async function importRealDataFile() {
    const input = byId("realDataFile");
    const file = input?.files?.[0];
    if (!file) {
      showToast("Выберите JSON или CSV файл");
      return;
    }

    const text = await file.text();
    const lowerName = file.name.toLowerCase();
    let rows = [];

    try {
      if (lowerName.endsWith(".json")) {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : parsed.products || [];
      } else {
        rows = parseCsv(text);
      }
      importProductsFromRows(rows);
    } catch {
      showToast("Не удалось прочитать файл");
    }
  }

  function downloadJsonTemplate() {
    const template = {
      products: [
        {
          sku: "IPH15P-256-NT",
          name: "iPhone 15 Pro 256 GB",
          category: "Смартфоны",
          status: "Готов к продаже",
          stock: 1,
          cost: 111000,
          price: 123900,
          condition: "Отличное",
          kit: "Коробка, кабель USB-C, чек магазина",
          description: "Описание состояния, гарантии и нюансов товара.",
          comment: "Внутренний комментарий",
          photoSource: "site",
          photoUrls: [
            "https://site.ru/photos/iphone-15-pro-1.jpg",
            "https://site.ru/photos/iphone-15-pro-2.jpg"
          ]
        }
      ]
    };
    downloadTextFile("imagnate-products-template.json", JSON.stringify(template, null, 2), "application/json;charset=utf-8");
  }

  function downloadCsvTemplate() {
    const csv = [
      "sku,name,category,status,stock,cost,price,condition,kit,description,comment,photoSource,photoUrls",
      "\"IPH15P-256-NT\",\"iPhone 15 Pro 256 GB\",\"Смартфоны\",\"Готов к продаже\",1,111000,123900,\"Отличное\",\"Коробка, кабель USB-C, чек магазина\",\"Описание состояния, гарантии и нюансов товара.\",\"Внутренний комментарий\",\"site\",\"https://site.ru/photos/iphone-15-pro-1.jpg;https://site.ru/photos/iphone-15-pro-2.jpg\""
    ].join("\n");
    downloadTextFile("imagnate-products-template.csv", csv, "text/csv;charset=utf-8");
  }

  function resetRealDataToDemo() {
    resetInventoryProducts();
    const result = byId("realDataImportResult");
    if (result) result.textContent = "Демо-товары возвращены. Можно снова загрузить JSON или CSV с реальными остатками.";
  }

  function renderTasks() {
    const target = byId("tasksList");
    if (!target) return;

    const open = tasks.filter((task) => !task.done).length;
    const counter = byId("openTasksCount");
    if (counter) counter.textContent = `${open} открытых`;

    target.innerHTML = tasks.map((task, index) => `
      <article class="task-item">
        <div class="panel-header">
          <div>
            <div class="task-title">${escapeHtml(task.title)}</div>
            <div class="task-meta">Ответственный: ${escapeHtml(task.owner)}. Срок: ${escapeHtml(task.due)}. Приоритет: ${escapeHtml(task.priority)}.</div>
          </div>
          <button class="ghost-btn" type="button" data-task="${index}">${task.done ? "Вернуть" : "Готово"}</button>
        </div>
      </article>
    `).join("");

    document.querySelectorAll("[data-task]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.task);
        tasks[index].done = !tasks[index].done;
        saveTasks();
        renderTasks();
        renderMetrics();
        showToast(tasks[index].done ? "Задача закрыта" : "Задача возвращена");
      });
    });
  }

  function renderEmployees() {
    const target = byId("employeesTable");
    if (!target) return;

    target.innerHTML = employees.map((employee) => {
      const canEdit = canEditEmployeeAccess(employee);
      const roleClass = getRoleClass(employee.role);
      const roleControl = canEdit
        ? `<select class="inline-select" data-access-role="${escapeHtml(employee.login)}">${getAccessRoleOptions(employee.role)}</select>`
        : `<span class="access-lock">${employee.role === "owner" ? "Начальник защищен" : "Ваш доступ"}</span>`;
      const statusControl = canEdit
        ? `<button class="ghost-btn compact-btn" type="button" data-access-toggle="${escapeHtml(employee.login)}">${employee.active ? "Отключить" : "Включить"}</button>`
        : "";

      return `
        <tr>
          <td><strong>${escapeHtml(employee.name)}</strong></td>
          <td>${escapeHtml(employee.login)}</td>
          <td><code>${escapeHtml(employee.password)}</code></td>
          <td><span class="status-pill ${roleClass}">${escapeHtml(employee.roleLabel)}</span></td>
          <td>${employee.active ? "Активен" : "Отключен"}</td>
          <td>
            <div class="access-row-actions">
              ${roleControl}
              ${statusControl}
            </div>
          </td>
        </tr>
      `;
    }).join("");

    document.querySelectorAll("[data-access-role]").forEach((select) => {
      select.addEventListener("change", () => {
        updateEmployeeAccess(select.dataset.accessRole, { role: select.value }, "Роль сотрудника обновлена");
      });
    });
    document.querySelectorAll("[data-access-toggle]").forEach((button) => {
      button.addEventListener("click", () => toggleEmployeeAccess(button.dataset.accessToggle));
    });
  }

  function getRoleClass(role) {
    if (role === "admin") return "blue";
    if (role === "seller") return "warning";
    return "";
  }

  function getAccessRoleOptions(selectedRole) {
    return ["seller", "admin"].map((role) => `
      <option value="${role}" ${selectedRole === role ? "selected" : ""}>${roleRules[role]?.label || role}</option>
    `).join("");
  }

  function canEditEmployeeAccess(employee) {
    if (!employee || !can("manage-employees")) return false;
    if (employee.role === "owner") return false;
    if (employee.login === currentUser?.login) return false;
    return true;
  }

  function renderAccessControl() {
    const employeeSelect = byId("accessEmployee");
    const roleSelect = byId("accessRole");
    const statusSelect = byId("accessStatus");
    const hint = byId("accessHint");
    if (!employeeSelect || !roleSelect || !statusSelect) return;

    const manageable = employees.filter(canEditEmployeeAccess);
    const previousLogin = employeeSelect.value;

    employeeSelect.innerHTML = manageable.map((employee) => `
      <option value="${escapeHtml(employee.login)}">${escapeHtml(employee.name)} · ${escapeHtml(employee.login)}</option>
    `).join("");

    const selectedEmployee = manageable.find((employee) => employee.login === previousLogin) || manageable[0];
    const disabled = !selectedEmployee;
    employeeSelect.disabled = disabled;
    roleSelect.disabled = disabled;
    statusSelect.disabled = disabled;
    byId("accessControlForm")?.querySelector("button")?.toggleAttribute("disabled", disabled);

    if (disabled) {
      if (hint) hint.textContent = "Нет сотрудников, которым можно изменить доступ.";
      return;
    }

    employeeSelect.value = selectedEmployee.login;
    roleSelect.value = selectedEmployee.role === "admin" ? "admin" : "seller";
    statusSelect.value = selectedEmployee.active ? "active" : "inactive";
    if (hint) {
      hint.textContent = `${selectedEmployee.name}: сейчас ${selectedEmployee.roleLabel.toLowerCase()}, вход ${selectedEmployee.active ? "включен" : "отключен"}.`;
    }
  }

  function updateEmployeeAccess(login, changes, message = "Доступ обновлен") {
    const employee = employees.find((item) => item.login === login);
    if (!canEditEmployeeAccess(employee)) {
      showToast("Этот доступ защищен");
      renderEmployees();
      renderAccessControl();
      return;
    }

    if (changes.role) {
      employee.role = changes.role === "admin" ? "admin" : "seller";
      employee.roleLabel = roleRules[employee.role]?.label || "Сотрудник";
    }

    if (typeof changes.active === "boolean") {
      employee.active = changes.active;
    }

    saveEmployees();
    renderEmployees();
    renderEmployeeMetrics();
    renderAccessControl();
    showToast(message);
  }

  function toggleEmployeeAccess(login) {
    const employee = employees.find((item) => item.login === login);
    if (!employee) return;
    updateEmployeeAccess(login, { active: !employee.active }, employee.active ? "Вход сотрудника отключен" : "Вход сотрудника включен");
  }

  function applyAccessControl(event) {
    event.preventDefault();
    const login = getFieldText("accessEmployee", "");
    const role = getFieldText("accessRole", "seller");
    const active = getFieldText("accessStatus", "active") === "active";
    updateEmployeeAccess(login, { role, active }, "Доступ сохранен");
  }

  function renderEmployeeMetrics() {
    const target = byId("employeeMetrics");
    if (!target) return;

    const owners = employees.filter((employee) => employee.role === "owner").length;
    const admins = employees.filter((employee) => employee.role === "admin").length;
    const sellers = employees.filter((employee) => employee.role === "seller").length;
    const active = employees.filter((employee) => employee.active).length;

    const metrics = [
      { label: "Всего сотрудников", value: String(employees.length), context: "В демо-базе" },
      { label: "Активны", value: String(active), context: "Могут войти" },
      { label: "Начальники", value: String(owners), context: "Полный бизнес-доступ" },
      { label: "Админы", value: String(admins), context: "Технический доступ" },
      { label: "Продавцы", value: String(sellers), context: "Рабочее окно", attention: true }
    ];

    target.innerHTML = metrics.map((item) => `
      <article class="metric-card ${item.attention ? "attention" : ""}">
        <div class="metric-label">${item.label}</div>
        <div class="metric-value">${item.value}</div>
        <div class="metric-context">${item.context}</div>
      </article>
    `).join("");
  }

  function addEmployeeFromForm(event) {
    event.preventDefault();

    const name = getFieldText("employeeName", "");
    const login = getFieldText("employeeLogin", "").toLowerCase();
    const password = getFieldText("employeePassword", "");
    const role = getFieldText("employeeRole", "seller");

    if (!name || !login || !password) {
      showToast("Заполните имя, логин и пароль");
      return;
    }

    if (employees.some((employee) => employee.login.toLowerCase() === login)) {
      showToast("Такой логин уже есть");
      return;
    }

    employees.push(normalizeEmployee({
      name,
      login,
      password,
      role,
      roleLabel: roleRules[role]?.label || "Сотрудник",
      active: true
    }));
    saveEmployees();
    event.target.reset();
    renderEmployees();
    renderEmployeeMetrics();
    renderAccessControl();
    showToast("Сотрудник добавлен");
  }

  function resetEmployees() {
    employees = getSeedEmployees();
    saveEmployees();
    currentUser = employees.find((employee) => employee.login === currentUser?.login) || employees[0] || null;
    saveCurrentUser(currentUser);
    renderEmployees();
    renderEmployeeMetrics();
    renderAccessControl();
    applyRoleUi();
    showToast("Демо-сотрудники сброшены");
  }

  function getVisibleQuestions() {
    const filter = byId("questionFilter")?.value || "all";
    let visible = questions;
    if (filter === "open") visible = questions.filter((item) => item.status !== "done");
    if (filter === "done") visible = questions.filter((item) => item.status === "done");
    if (filter === "mine") {
      visible = can("manage-employees")
        ? questions.filter((item) => item.answeredBy === currentUser?.name)
        : questions.filter((item) => item.authorLogin === currentUser?.login);
    }
    if (!can("manage-employees")) {
      visible = visible.filter((item) => item.authorLogin === currentUser?.login || item.status !== "done");
    }
    return visible;
  }

  function renderQuestionRoleUi() {
    const isManager = can("manage-employees");
    const sellerLayout = byId("sellerQuestionLayout");
    const ownerPanel = byId("ownerQuestionPanel");
    if (sellerLayout) sellerLayout.hidden = isManager;
    if (ownerPanel) ownerPanel.hidden = !isManager;

    const filter = byId("questionFilter");
    const mineOption = filter?.querySelector('option[value="mine"]');
    if (mineOption && isManager) {
      mineOption.textContent = "Мои ответы";
    } else if (mineOption) {
      mineOption.textContent = "Мои";
    }
  }

  function renderQuestionMetrics() {
    const target = byId("questionMetrics");
    if (!target) return;

    const open = questions.filter((item) => item.status !== "done").length;
    const urgent = questions.filter((item) => item.status !== "done" && item.priority === "Срочно").length;
    const mine = can("manage-employees")
      ? questions.filter((item) => item.answeredBy === currentUser?.name).length
      : questions.filter((item) => item.authorLogin === currentUser?.login).length;
    const done = questions.filter((item) => item.status === "done").length;

    const metrics = [
      { label: "Открытые", value: String(open), context: "Ждут решения" },
      { label: "Срочные", value: String(urgent), context: "Разобрать первыми", attention: urgent > 0 },
      { label: can("manage-employees") ? "Мои ответы" : "Мои вопросы", value: String(mine), context: currentUser?.name || "Сотрудник" },
      { label: "Закрытые", value: String(done), context: "Уже разобраны" }
    ];

    target.innerHTML = metrics.map((item) => `
      <article class="metric-card ${item.attention ? "attention" : ""}">
        <div class="metric-label">${item.label}</div>
        <div class="metric-value">${item.value}</div>
        <div class="metric-context">${item.context}</div>
      </article>
    `).join("");
  }

  function renderQuestions() {
    const target = byId("questionsList");
    if (!target) return;

    const visible = getVisibleQuestions();
    if (!visible.length) {
      target.innerHTML = `
        <article class="task-item">
          <div class="task-title">Вопросов нет</div>
          <div class="task-meta">${can("manage-employees") ? "Сейчас входящих вопросов для ответа нет." : "Можно добавить новый вопрос через форму выше."}</div>
        </article>
      `;
      return;
    }

    target.innerHTML = visible.map((item) => {
      const canClose = can("manage-employees") && item.status !== "done";
      const canReopen = can("manage-employees") && item.status === "done";
      const canReply = can("manage-employees");
      const isReplyOpen = activeReplyQuestionId === item.id;
      const priorityClass = item.priority === "Срочно" ? "danger" : item.priority === "Важно" ? "warning" : "";
      const answerText = item.answer || "";
      const answerBlock = answerText && !isReplyOpen ? `
        <div class="question-answer">
          <div class="question-answer-title">Ответ ${escapeHtml(item.answeredBy || "владельца")}${item.answeredAt ? ` · ${escapeHtml(item.answeredAt)}` : ""}</div>
          <div class="question-answer-body">${escapeHtml(answerText)}</div>
        </div>
      ` : "";
      const replyBlock = isReplyOpen ? `
        <div class="question-reply">
          <label for="questionReply${item.id}">Ответ для ${escapeHtml(item.authorName)}</label>
          <textarea id="questionReply${item.id}" data-question-reply-text="${item.id}">${escapeHtml(answerText || getQuestionReplyStart(item))}</textarea>
          <div class="content-actions">
            <button class="primary-btn compact-btn" type="button" data-question-save-reply="${item.id}">Сохранить ответ</button>
            <button class="ghost-btn compact-btn" type="button" data-question-copy-reply="${item.id}">Скопировать</button>
            <button class="ghost-btn compact-btn" type="button" data-question-cancel-reply="${item.id}">Отмена</button>
          </div>
        </div>
      ` : "";

      return `
        <article class="task-item">
          <div class="panel-header">
            <div>
              <span class="status-pill ${priorityClass}">${escapeHtml(item.priority)}</span>
              <span class="status-pill blue">${escapeHtml(item.type)}</span>
              <div class="task-title">${escapeHtml(item.title)}</div>
              <div class="task-meta">${escapeHtml(item.text || "Без подробностей")}</div>
              <div class="task-meta">Автор: ${escapeHtml(item.authorName)} · ${escapeHtml(item.createdAt)} · Статус: ${item.status === "done" ? "закрыт" : "открыт"}</div>
            </div>
            <div class="question-actions">
              ${canReply ? `<button class="ghost-btn compact-btn" type="button" data-question-reply="${item.id}">${answerText ? "Изменить ответ" : "Ответить"}</button>` : ""}
              ${canClose ? `<button class="ghost-btn compact-btn" type="button" data-question-done="${item.id}">Закрыть</button>` : ""}
              ${canReopen ? `<button class="ghost-btn compact-btn" type="button" data-question-open="${item.id}">Вернуть</button>` : ""}
            </div>
          </div>
          ${answerBlock}
          ${replyBlock}
        </article>
      `;
    }).join("");

    document.querySelectorAll("[data-question-reply]").forEach((button) => {
      button.addEventListener("click", () => openQuestionReply(Number(button.dataset.questionReply)));
    });
    document.querySelectorAll("[data-question-save-reply]").forEach((button) => {
      button.addEventListener("click", () => saveQuestionReply(Number(button.dataset.questionSaveReply)));
    });
    document.querySelectorAll("[data-question-copy-reply]").forEach((button) => {
      button.addEventListener("click", () => copyQuestionReply(Number(button.dataset.questionCopyReply)));
    });
    document.querySelectorAll("[data-question-cancel-reply]").forEach((button) => {
      button.addEventListener("click", () => {
        activeReplyQuestionId = null;
        renderQuestions();
      });
    });
    document.querySelectorAll("[data-question-done]").forEach((button) => {
      button.addEventListener("click", () => updateQuestionStatus(Number(button.dataset.questionDone), "done"));
    });
    document.querySelectorAll("[data-question-open]").forEach((button) => {
      button.addEventListener("click", () => updateQuestionStatus(Number(button.dataset.questionOpen), "open"));
    });
  }

  function getQuestionReplyStart(question) {
    return `Привет, ${question.authorName}! \n\n`;
  }

  function openQuestionReply(id) {
    activeReplyQuestionId = id;
    renderQuestions();
    byId(`questionReply${id}`)?.focus();
  }

  function getQuestionReplyText(id) {
    return document.querySelector(`[data-question-reply-text="${id}"]`)?.value.trim() || "";
  }

  function saveQuestionReply(id) {
    const question = questions.find((item) => item.id === id);
    if (!question) return;
    const answer = getQuestionReplyText(id);
    if (!answer) {
      showToast("Введите ответ");
      byId(`questionReply${id}`)?.focus();
      return;
    }

    question.answer = answer;
    question.answeredBy = currentUser?.name || "Леонид";
    question.answeredAt = new Date().toLocaleString("ru-RU");
    question.status = "done";
    activeReplyQuestionId = null;
    saveQuestions();
    renderQuestions();
    renderQuestionMetrics();
    showToast("Ответ сохранен");
  }

  function copyQuestionReply(id) {
    const text = getQuestionReplyText(id);
    if (!text) {
      showToast("Ответ пока пустой");
      return;
    }
    copyText(text);
  }

  function updateQuestionStatus(id, status) {
    const question = questions.find((item) => item.id === id);
    if (!question) return;
    question.status = status;
    activeReplyQuestionId = null;
    saveQuestions();
    renderQuestions();
    renderQuestionMetrics();
    showToast(status === "done" ? "Вопрос закрыт" : "Вопрос возвращен");
  }

  function addQuestionFromForm(event) {
    event.preventDefault();
    const title = getFieldText("questionTitle", "");
    if (!title) {
      showToast("Введите короткий вопрос");
      byId("questionTitle")?.focus();
      return;
    }

    questions.unshift({
      id: Date.now(),
      type: getFieldText("questionType", "Вопрос"),
      priority: getFieldText("questionPriority", "Обычный"),
      title,
      text: getFieldText("questionText", ""),
      authorName: currentUser?.name || "Сотрудник",
      authorLogin: currentUser?.login || "unknown",
      status: "open",
      createdAt: new Date().toLocaleString("ru-RU"),
      answer: "",
      answeredBy: "",
      answeredAt: ""
    });

    saveQuestions();
    event.target.reset();
    renderQuestions();
    renderQuestionMetrics();
    showToast("Вопрос отправлен");
  }

  function renderSiteImport() {
    const routesTarget = byId("siteRoutesList");
    const categoriesTarget = byId("siteCategoriesList");
    const optionsTarget = byId("importOptionsList");
    if (!routesTarget || !categoriesTarget || !optionsTarget) return;

    const info = seed.siteImport || {};
    routesTarget.innerHTML = (info.routes || []).map((route) => `
      <article class="activity-item">
        <div class="attention-title">${escapeHtml(route.title)}</div>
        <div class="activity-meta">${escapeHtml(route.url)}</div>
      </article>
    `).join("");

    categoriesTarget.innerHTML = (info.catalogCategories || []).map((category) => `
      <article class="activity-item">
        <div class="attention-title">${escapeHtml(category.title)}</div>
        <div class="activity-meta">${escapeHtml(category.url)}</div>
      </article>
    `).join("");

    optionsTarget.innerHTML = (info.importOptions || []).map((option) => `
      <article class="attention-item">
        <span class="status-pill ${option.risk === "Средний" ? "warning" : ""}">Риск: ${escapeHtml(option.risk)}</span>
        <div class="attention-title">${escapeHtml(option.name)}</div>
        <div class="attention-meta">${escapeHtml(option.description)}</div>
      </article>
    `).join("");

    const pageMetaTarget = byId("sitePageMetaList");
    if (pageMetaTarget) {
      pageMetaTarget.innerHTML = (info.pageMeta || []).map((page) => `
        <article class="activity-item">
          <div class="attention-title">${escapeHtml(page.title)}</div>
          <div class="activity-meta">${escapeHtml(page.description)}</div>
          <div class="activity-meta">${escapeHtml(page.url)}</div>
        </article>
      `).join("");
    }

    const productsTarget = byId("siteProductsTable");
    if (productsTarget) {
      productsTarget.innerHTML = (info.sampleProducts || []).map((product) => `
        <tr>
          <td>
            <strong>${escapeHtml(product.title)}</strong>
            <div class="activity-meta">${escapeHtml(product.url)}</div>
          </td>
          <td>${escapeHtml(product.category)}</td>
          <td>${escapeHtml(product.importUse)}</td>
        </tr>
      `).join("");
    }

    const promotionsTarget = byId("sitePromotionsList");
    if (promotionsTarget) {
      promotionsTarget.innerHTML = (info.promotions || []).map((promotion) => `
        <article class="attention-item">
          <span class="status-pill">Акция</span>
          <div class="attention-title">${escapeHtml(promotion.title)}</div>
          <div class="attention-meta">${escapeHtml(promotion.importUse)}</div>
          <div class="activity-meta">${escapeHtml(promotion.url)}</div>
        </article>
      `).join("");
    }

    const articlesTarget = byId("siteArticlesList");
    if (articlesTarget) {
      articlesTarget.innerHTML = (info.articles || []).map((article) => `
        <article class="attention-item">
          <span class="status-pill blue">Статья</span>
          <div class="attention-title">${escapeHtml(article.title)}</div>
          <div class="attention-meta">${escapeHtml(article.importUse)}</div>
          <div class="activity-meta">${escapeHtml(article.url)}</div>
        </article>
      `).join("");
    }
  }

  function simulateSiteImport() {
    const result = byId("siteImportResult");
    if (!result) return;

    const info = seed.siteImport || {};
    result.textContent = [
      "Проверка публичного сайта выполнена в демо-режиме.",
      "",
      `Найдено разделов: ${(info.routes || []).length}.`,
      `Найдено категорий каталога: ${(info.catalogCategories || []).length}.`,
      `Найдено мета-страниц: ${(info.pageMeta || []).length}.`,
      `Примеров карточек: ${(info.sampleProducts || []).length}.`,
      `Акций: ${(info.promotions || []).length}.`,
      `Статей: ${(info.articles || []).length}.`,
      "",
      "Вывод: с публичного сайта полезно брать структуру, контент, акции и базовые карточки. Для цен, остатков, заказов и прибыли нужен доступ к CRM/API или регулярная выгрузка."
    ].join("\n");
    showToast("Импорт смоделирован");
  }

  function isLoginPage() {
    return document.body.dataset.page === "login";
  }

  function isProtectedPageAllowed() {
    const page = document.body.dataset.page || "dashboard";
    if (page === "site-import") return can("site-import");
    if (page === "employees") return can("manage-employees");
    return true;
  }

  function enforceAuth() {
    if (isLoginPage()) return true;

    if (!currentUser) {
      window.location.href = "login.html";
      return false;
    }

    if (!isProtectedPageAllowed()) {
      window.location.href = "index.html";
      return false;
    }

    return true;
  }

  function handleLogin(event) {
    event.preventDefault();
    const login = getFieldText("loginName", "").toLowerCase();
    const password = getFieldText("loginPassword", "");
    const user = employees.find((employee) => employee.login.toLowerCase() === login && employee.password === password && employee.active);
    const error = byId("loginError");

    if (!user) {
      if (error) error.textContent = "Неверный логин или пароль.";
      return;
    }

    currentUser = user;
    saveCurrentUser(user);
    window.location.href = "index.html";
  }

  function logout() {
    saveCurrentUser(null);
    currentUser = null;
    window.location.href = "login.html";
  }

  function renderLoginUsers() {
    const target = byId("demoUsersTable");
    if (!target) return;

    target.innerHTML = employees.map((employee) => `
      <tr>
        <td><strong>${escapeHtml(employee.name)}</strong></td>
        <td>${escapeHtml(employee.login)}</td>
        <td><code>${escapeHtml(employee.password)}</code></td>
        <td><span class="status-pill ${employee.role === "owner" ? "" : employee.role === "admin" ? "blue" : "warning"}">${escapeHtml(employee.roleLabel)}</span></td>
      </tr>
    `).join("");
  }

  function renderUserPanel() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar || !currentUser || byId("userPanel")) return;

    const footer = sidebar.querySelector(".sidebar-footer");
    const panel = document.createElement("section");
    panel.className = "user-panel";
    panel.id = "userPanel";
    panel.innerHTML = `
      <div>
        <div class="user-name">${escapeHtml(currentUser.name)}</div>
        <div class="user-role">${escapeHtml(currentUser.roleLabel)} · ${escapeHtml(currentUser.login)}</div>
      </div>
      <button class="ghost-btn btn-block" type="button" id="logoutButton">Выйти</button>
    `;

    if (footer) {
      sidebar.insertBefore(panel, footer);
    } else {
      sidebar.appendChild(panel);
    }
  }

  function applyRoleUi() {
    if (!currentUser) return;

    document.querySelectorAll("[data-permission]").forEach((element) => {
      const permission = element.dataset.permission;
      element.hidden = !can(permission);
    });

    if (!can("manage-system")) {
      const resetInventory = byId("resetInventoryProducts");
      if (resetInventory) resetInventory.hidden = true;
    }

    document.querySelectorAll("[data-current-user]").forEach((element) => {
      element.textContent = currentUser.name;
    });
    document.querySelectorAll("[data-current-role]").forEach((element) => {
      element.textContent = currentUser.roleLabel;
    });
  }

  function ensureFloatingAssistant() {
    if (byId("assistantFab")) return;

    document.body.insertAdjacentHTML("beforeend", `
      <div class="toast" id="toast" role="status" aria-live="polite">Скопировано</div>

      <section class="floating-assistant" id="floatingAssistant" aria-label="AI-ассистент" hidden>
        <div class="floating-header">
          <div class="floating-title">
            <strong>AI-ассистент</strong>
            <span class="metric-label">Пока демо-логика, позже подключим нейросеть</span>
          </div>
          <div class="floating-actions">
            <button class="icon-btn" type="button" id="floatingClear" aria-label="Очистить диалог">C</button>
            <button class="icon-btn" type="button" id="floatingClose" aria-label="Закрыть">X</button>
          </div>
        </div>
        <div class="floating-chat" id="floatingChatBox"></div>
        <div class="floating-controls">
          <div class="floating-prompts">
            <button class="btn" type="button" data-floating-prompt="Что сегодня требует внимания?">Что важно</button>
            <button class="btn" type="button" data-floating-prompt="Какие товары залежались?">Залежалось</button>
            <button class="btn" type="button" data-floating-prompt="Сформируй задачи сотрудникам">Задачи</button>
            <button class="btn" type="button" data-floating-prompt="Что можно подтянуть с сайта iMagnate?">Сайт</button>
          </div>
          <div class="floating-input">
            <input id="floatingChatInput" type="text" placeholder="Спросить ассистента">
            <button class="primary-btn" type="button" id="floatingSend">Спросить</button>
          </div>
        </div>
      </section>

      <button class="assistant-fab" type="button" id="assistantFab" aria-expanded="false" aria-controls="floatingAssistant" aria-label="Открыть AI-ассистента">?</button>
    `);
  }

  function openFloatingAssistant() {
    const panel = byId("floatingAssistant");
    panel.hidden = false;
    byId("assistantFab").setAttribute("aria-expanded", "true");
    renderChat();
  }

  function closeFloatingAssistant() {
    const panel = byId("floatingAssistant");
    if (!panel) return;
    panel.hidden = true;
    byId("assistantFab").setAttribute("aria-expanded", "false");
  }

  function toggleFloatingAssistant() {
    if (byId("floatingAssistant").hidden) {
      openFloatingAssistant();
      byId("floatingChatInput").focus();
    } else {
      closeFloatingAssistant();
    }
  }

  async function copyText(text) {
    try {
      if (!navigator.clipboard || !window.isSecureContext) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      showToast("Скопировано");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      showToast(copied ? "Скопировано" : "Не удалось скопировать");
    }
  }

  function showToast(text) {
    const toast = byId("toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("visible");
    window.setTimeout(() => toast.classList.remove("visible"), 1800);
  }

  function bindEvents() {
    byId("loginForm")?.addEventListener("submit", handleLogin);
    byId("logoutButton")?.addEventListener("click", logout);

    document.querySelectorAll("[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => sendChat(button.dataset.prompt));
    });

    byId("sendChat")?.addEventListener("click", () => sendChat());
    byId("chatInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") sendChat();
    });

    byId("generateContent")?.addEventListener("click", renderContent);
    byId("productPhotos")?.addEventListener("change", handlePhotoUpload);
    byId("prepareSiteCard")?.addEventListener("click", prepareSiteCard);
    byId("publishToSite")?.addEventListener("click", publishToSite);
    byId("copyContent")?.addEventListener("click", () => {
      const content = createContentText();
      copyText([content.site, content.telegram, content.marketplace].join("\n\n---\n\n"));
    });
    byId("copyDigest")?.addEventListener("click", () => copyText(byId("ownerDigest").textContent));
    byId("copyShift")?.addEventListener("click", () => copyText(byId("shiftReport").textContent));
    byId("inventoryFilter")?.addEventListener("change", renderProducts);
    byId("inventorySearch")?.addEventListener("input", renderProducts);
    byId("addProductForm")?.addEventListener("submit", addProductFromForm);
    byId("resetInventoryProducts")?.addEventListener("click", resetInventoryProducts);
    byId("closeAvitoModal")?.addEventListener("click", closeAvitoModal);
    byId("cancelAvitoModal")?.addEventListener("click", closeAvitoModal);
    byId("submitAvitoListing")?.addEventListener("click", submitAvitoListing);
    byId("copyAvitoPayload")?.addEventListener("click", copyAvitoPayload);
    byId("downloadAvitoXml")?.addEventListener("click", downloadAvitoXml);
    byId("downloadAvitoJson")?.addEventListener("click", downloadAvitoJson);
    byId("copyAvitoProfile")?.addEventListener("click", copyAvitoProfileUrl);
    byId("avitoPhotos")?.addEventListener("change", handleAvitoPhotoUpload);
    ["avitoPrice", "avitoCategory", "avitoCondition", "avitoCity", "avitoContact", "avitoKit", "avitoDescription", "avitoPhotoUrls", "avitoPhotoSource"].forEach((id) => {
      byId(id)?.addEventListener("input", renderAvitoPayloadPreview);
      byId(id)?.addEventListener("change", renderAvitoPayloadPreview);
    });
    byId("importRealData")?.addEventListener("click", importRealDataFile);
    byId("downloadJsonTemplate")?.addEventListener("click", downloadJsonTemplate);
    byId("downloadCsvTemplate")?.addEventListener("click", downloadCsvTemplate);
    byId("resetRealData")?.addEventListener("click", resetRealDataToDemo);
    byId("avitoModal")?.addEventListener("click", (event) => {
      if (event.target === byId("avitoModal")) closeAvitoModal();
    });
    byId("addEmployeeForm")?.addEventListener("submit", addEmployeeFromForm);
    byId("accessControlForm")?.addEventListener("submit", applyAccessControl);
    byId("accessEmployee")?.addEventListener("change", renderAccessControl);
    byId("resetEmployees")?.addEventListener("click", resetEmployees);
    byId("questionForm")?.addEventListener("submit", addQuestionFromForm);
    byId("questionFilter")?.addEventListener("change", renderQuestions);
    byId("simulateImport")?.addEventListener("click", simulateSiteImport);

    byId("assistantFab")?.addEventListener("click", toggleFloatingAssistant);
    byId("floatingClose")?.addEventListener("click", closeFloatingAssistant);
    byId("floatingClear")?.addEventListener("click", resetAssistantChat);
    byId("floatingSend")?.addEventListener("click", () => sendFloatingChat());
    byId("floatingChatInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") sendFloatingChat();
    });
    document.querySelectorAll("[data-floating-prompt]").forEach((button) => {
      button.addEventListener("click", () => sendFloatingChat(button.dataset.floatingPrompt));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeFloatingAssistant();
        closeAvitoModal();
      }
    });

    ["cashStart", "cashSales", "cardSales", "transfers", "refunds", "expenses", "collection", "cashActual", "shiftComment"].forEach((id) => {
      byId(id)?.addEventListener("input", () => {
        renderShift();
        renderDigest();
        renderMetrics();
      });
    });

    ["productName", "productMemory", "productColor", "productPrice", "productCondition", "productWarranty", "productKit"].forEach((id) => {
      byId(id)?.addEventListener("input", () => {
        renderContent();
        renderSitePayload();
      });
      byId(id)?.addEventListener("change", () => {
        renderContent();
        renderSitePayload();
      });
    });
  }

  function markActivePage() {
    const page = document.body.dataset.page || "dashboard";
    document.querySelectorAll("[data-page-link]").forEach((link) => {
      link.classList.toggle("active", link.dataset.pageLink === page);
    });
  }

  function renderToday() {
    const label = byId("todayLabel");
    if (!label) return;

    label.textContent = new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric"
    }).format(new Date());
  }

  function refreshAll() {
    renderMetrics();
    renderAttention();
    renderActivity();
    renderDigest();
    renderChat();
    renderContent();
    renderShift();
    renderProducts();
    renderInventoryMetrics();
    renderAvitoOverview();
    renderTasks();
    renderEmployees();
    renderEmployeeMetrics();
    renderAccessControl();
    renderQuestionRoleUi();
    renderQuestions();
    renderQuestionMetrics();
    renderSiteImport();
  }

  function init() {
    if (isLoginPage()) {
      renderLoginUsers();
      bindEvents();
      return;
    }

    if (!enforceAuth()) return;

    ensureFloatingAssistant();
    renderUserPanel();
    markActivePage();
    applyRoleUi();
    renderToday();
    refreshAll();
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
