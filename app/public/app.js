'use strict';

(() => {
  const createForm = document.getElementById('create-form');
  const editForm = document.getElementById('edit-form');
  const editDialog = document.getElementById('edit-dialog');
  const deleteDialog = document.getElementById('delete-dialog');
  const deleteDialogMessage = document.getElementById('delete-dialog-message');
  const productsTbody = document.getElementById('products-tbody');
  const productCountEl = document.getElementById('product-count');
  const statusAlert = document.getElementById('status-alert');
  const refreshBtn = document.getElementById('refresh-btn');
  const editCancelBtn = document.getElementById('edit-cancel-btn');
  const editCloseX = document.getElementById('edit-close-x');

  const podBadge = document.getElementById('pod-badge');
  const dbBadge = document.getElementById('db-badge');
  const memoryBadge = document.getElementById('memory-badge');

  let pendingDeleteProduct = null;
  let alertTimer = null;

  // Accessible validation synchronization for :user-invalid + fallback for older browsers
  const linkError = (el, shown) => {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) {
      el.setAttribute('aria-describedby', ids.join(' '));
    } else {
      el.removeAttribute('aria-describedby');
    }
  };

  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);

  let announceTimer;
  let announcedField;

  const spokenText = (node) => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    copy.querySelectorAll('[role="img"][aria-label]').forEach((n) => {
      n.replaceWith(`${n.getAttribute('aria-label')}: `);
    });
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };

  const announceError = (el) => {
    const errorEl = document.getElementById(el.dataset.error);
    if (!errorEl) return;
    const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = label + spokenText(errorEl);
    }, 500);
  };

  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const dirtyState = new WeakMap();
  const flagged = new WeakSet();
  const announced = new WeakSet();

  const isFieldUserInvalid = (el) => {
    if (supportsUserInvalid) {
      return el.matches(':user-invalid');
    }
    return el.classList.contains('user-invalid-fallback');
  };

  const syncAria = (el, announce = false) => {
    if (!el.matches?.('input, select, textarea')) return;
    const invalid = isFieldUserInvalid(el);
    if (invalid) {
      if (announce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute('aria-invalid', 'true');
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
      el.setAttribute('aria-invalid', 'false');
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  const updateFallbackClasses = (el) => {
    if (supportsUserInvalid || !el.validity) return;
    const valid = el.validity.valid;
    el.classList.toggle('user-invalid-fallback', !valid);
    el.classList.toggle('user-valid-fallback', valid);
  };

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    el.setAttribute('aria-invalid', 'false');
  });

  document.addEventListener(
    'blur',
    (e) => {
      const el = e.target;
      if (!el.matches?.('input, select, textarea')) return;
      if (!supportsUserInvalid) {
        const state = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
        state.hasBlurred = true;
        dirtyState.set(el, state);
        if (state.hasInteracted) updateFallbackClasses(el);
      }
      syncAria(el, true);
    },
    true
  );

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches?.('input, select, textarea')) return;
    if (!supportsUserInvalid) {
      const state = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
      state.hasInteracted = true;
      dirtyState.set(el, state);
      if (state.hasBlurred) updateFallbackClasses(el);
    }
    if (el.hasAttribute('aria-invalid')) syncAria(el);
  });

  document.addEventListener(
    'invalid',
    (e) => {
      const el = e.target;
      if (!supportsUserInvalid) {
        dirtyState.set(el, { hasInteracted: true, hasBlurred: true });
        updateFallbackClasses(el);
      }
      announced.add(el);
      syncAria(el);
    },
    true
  );

  document.addEventListener(
    'reset',
    (e) => {
      setTimeout(() => {
        for (const el of e.target.elements || []) {
          dirtyState.delete(el);
          el.classList.remove('user-invalid-fallback', 'user-valid-fallback');
          syncAria(el);
        }
      });
    },
    true
  );

  // Light-dismiss fallback for browsers without native <dialog closedby="any">
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const isOutside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', (e) => {
        pressedOutside = isOutside(e, dialog);
      });
      dialog.addEventListener('pointerup', (e) => {
        if (pressedOutside && isOutside(e, dialog)) {
          dialog.close();
        }
      });
    }
  }

  function showAlert(message, type = 'success') {
    clearTimeout(alertTimer);
    statusAlert.textContent = message;
    statusAlert.className = `alert alert-${type}`;
    alertTimer = setTimeout(() => {
      statusAlert.classList.add('d-none');
    }, 4500);
  }

  function formatCurrency(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '$0.00';
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'USD',
    }).format(numeric);
  }

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Error HTTP ${response.status}`);
    }
    return data;
  }

  async function loadRuntimeInfo() {
    try {
      const info = await apiRequest('/api/info');
      podBadge.textContent = `Pod: ${info.pod}`;
      dbBadge.textContent = `DB: ${info.databaseStatus === 'connected' ? 'PostgreSQL OK' : 'Reconectando...'}`;
      dbBadge.className = `badge ${info.databaseStatus === 'connected' ? 'text-bg-success' : 'text-bg-warning text-dark'}`;
      memoryBadge.textContent = `RAM RSS: ${info.memoryUsageMB.rss} MB`;
    } catch (_err) {
      dbBadge.textContent = 'DB: sin respuesta';
      dbBadge.className = 'badge text-bg-danger';
    }
  }

  function renderProductsTable(items) {
    productsTbody.textContent = '';
    productCountEl.textContent = String(items.length);

    if (items.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'text-center text-muted py-4';
      cell.textContent = 'No hay productos registrados. Crea el primero usando el formulario.';
      row.append(cell);
      productsTbody.append(row);
      return;
    }

    for (const product of items) {
      const row = document.createElement('tr');

      const nameHeader = document.createElement('th');
      nameHeader.scope = 'row';
      nameHeader.textContent = product.name;

      const categoryCell = document.createElement('td');
      const categoryBadge = document.createElement('span');
      categoryBadge.className = 'badge text-bg-light border text-dark';
      categoryBadge.textContent = product.category;
      categoryCell.append(categoryBadge);

      const priceCell = document.createElement('td');
      priceCell.textContent = formatCurrency(product.price);

      const stockCell = document.createElement('td');
      const stockBadge = document.createElement('span');
      stockBadge.className =
        Number(product.stock) > 0 ? 'badge text-bg-success' : 'badge text-bg-danger';
      stockBadge.textContent = `${product.stock} u.`;
      stockCell.append(stockBadge);

      const descriptionCell = document.createElement('td');
      descriptionCell.textContent = product.description || '-';

      const actionsCell = document.createElement('td');
      const actionsGroup = document.createElement('div');
      actionsGroup.className = 'd-flex gap-2';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-sm btn-outline-primary';
      editBtn.textContent = 'Editar';
      editBtn.addEventListener('click', () => openEditDialog(product));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-sm btn-outline-danger';
      deleteBtn.textContent = 'Eliminar';
      deleteBtn.addEventListener('click', () => openDeleteDialog(product));

      actionsGroup.append(editBtn, deleteBtn);
      actionsCell.append(actionsGroup);

      row.append(nameHeader, categoryCell, priceCell, stockCell, descriptionCell, actionsCell);
      productsTbody.append(row);
    }
  }

  async function loadProducts() {
    try {
      const payload = await apiRequest('/api/products');
      renderProductsTable(payload.items || []);
      if (payload.pod) {
        podBadge.textContent = `Pod: ${payload.pod}`;
      }
    } catch (err) {
      showAlert(err.message, 'danger');
    }
  }

  function openEditDialog(product) {
    editForm.reset();
    document.getElementById('edit-id').value = product.id;
    document.getElementById('edit-name').value = product.name;
    document.getElementById('edit-category').value = product.category;
    document.getElementById('edit-price').value = product.price;
    document.getElementById('edit-stock').value = product.stock;
    document.getElementById('edit-description').value = product.description || '';
    editDialog.showModal();
  }

  function openDeleteDialog(product) {
    pendingDeleteProduct = product;
    deleteDialogMessage.textContent = `¿Deseas eliminar el producto "${product.name}" (ID #${product.id}) de forma permanente?`;
    deleteDialog.showModal();
  }

  // Create Product (POST)
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!createForm.reportValidity()) {
      const firstInvalid = createForm.querySelector(':invalid');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const formData = new FormData(createForm);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      category: String(formData.get('category') || '').trim(),
      price: Number(formData.get('price')),
      stock: Number(formData.get('stock')),
      description: String(formData.get('description') || '').trim(),
    };

    try {
      const res = await apiRequest('/api/products', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      createForm.reset();
      showAlert(`Producto "${res.item.name}" creado correctamente (Pod: ${res.pod}).`, 'success');
      await Promise.all([loadProducts(), loadRuntimeInfo()]);
    } catch (err) {
      showAlert(err.message, 'danger');
    }
  });

  // Update Product (PUT)
  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!editForm.reportValidity()) {
      const firstInvalid = editForm.querySelector(':invalid');
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const id = document.getElementById('edit-id').value;
    const payload = {
      name: document.getElementById('edit-name').value.trim(),
      category: document.getElementById('edit-category').value.trim(),
      price: Number(document.getElementById('edit-price').value),
      stock: Number(document.getElementById('edit-stock').value),
      description: document.getElementById('edit-description').value.trim(),
    };

    try {
      const res = await apiRequest(`/api/products/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      editDialog.close('saved');
      showAlert(`Producto "${res.item.name}" actualizado correctamente.`, 'success');
      await Promise.all([loadProducts(), loadRuntimeInfo()]);
    } catch (err) {
      showAlert(err.message, 'danger');
    }
  });

  editCancelBtn.addEventListener('click', () => editDialog.close('cancel'));
  editCloseX.addEventListener('click', () => editDialog.close('cancel'));
  editDialog.addEventListener('close', () => {
    editDialog.returnValue = '';
  });

  // Delete Product (DELETE) upon native dialog confirmation
  deleteDialog.addEventListener('close', async () => {
    const decision = deleteDialog.returnValue;
    deleteDialog.returnValue = '';

    const target = pendingDeleteProduct;
    pendingDeleteProduct = null;

    if (decision !== 'confirm' || !target) return;

    try {
      await apiRequest(`/api/products/${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      });
      showAlert(`Producto "${target.name}" eliminado correctamente.`, 'warning');
      await Promise.all([loadProducts(), loadRuntimeInfo()]);
    } catch (err) {
      showAlert(err.message, 'danger');
    }
  });

  refreshBtn.addEventListener('click', () => {
    Promise.all([loadProducts(), loadRuntimeInfo()]);
  });

  // Initial load + periodic runtime telemetry refresh
  Promise.all([loadProducts(), loadRuntimeInfo()]);
  setInterval(loadRuntimeInfo, 10000);
})();
