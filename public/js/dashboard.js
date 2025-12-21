// Check Auth
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || '{}');

if (!token) {
    window.location.href = '/login';
}

document.getElementById('userName').textContent = user.name || 'Admin';

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
}

const formatCurrency = (amount) => {
    return new Intl.NumberFormat('ar-SA', { style: 'currency', currency: 'SAR' }).format(amount);
};

const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('ar-SA');
};

const api = {
    get: async (url) => {
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401) logout();
        return res.json();
    }
};

const filters = {
    apply: () => {
        loadReports();
        loadStats();
    }
};

async function loadMetadata() {
    try {
        const data = await api.get('/api/metadata');

        // Populate Branches
        const branchSelect = document.getElementById('filterBranch');
        data.branches.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.branch_name;
            branchSelect.appendChild(opt);
        });

        // Populate Cashiers
        const cashierSelect = document.getElementById('filterCashier');
        data.cashiers.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.name} (${c.cashier_number})`;
            cashierSelect.appendChild(opt);
        });

    } catch (err) {
        console.error('Failed to load metadata:', err);
    }
}

async function loadStats() {
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const status = document.getElementById('filterStatus').value;
    const branchId = document.getElementById('filterBranch').value;
    const cashierId = document.getElementById('filterCashier').value;

    try {
        let url = '/api/stats?q=1';
        if (dateFrom) url += `&dateFrom=${dateFrom}`;
        if (dateTo) url += `&dateTo=${dateTo}`;
        if (status) url += `&status=${status}`;
        if (branchId) url += `&branchId=${branchId}`;
        if (cashierId) url += `&cashierId=${cashierId}`;

        const stats = await api.get(url);
        document.getElementById('totalReconciliations').textContent = stats.totalReconciliations;
        document.getElementById('totalReceipts').textContent = formatCurrency(stats.totalReceipts);
        document.getElementById('totalSales').textContent = formatCurrency(stats.totalSales);
    } catch (err) {
        console.error(err);
    }
}

async function loadReports() {
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const status = document.getElementById('filterStatus').value;
    const branchId = document.getElementById('filterBranch').value;
    const cashierId = document.getElementById('filterCashier').value;

    const tbody = document.getElementById('reportsTable');

    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">جاري التحميل...</td></tr>';

    try {
        let url = '/api/reports?q=1';
        if (dateFrom) url += `&dateFrom=${dateFrom}`;
        if (dateTo) url += `&dateTo=${dateTo}`;
        if (status) url += `&status=${status}`;
        if (branchId) url += `&branchId=${branchId}`;
        if (cashierId) url += `&cashierId=${cashierId}`;

        const reports = await api.get(url);

        tbody.innerHTML = '';

        if (reports.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">لا توجد بيانات</td></tr>';
            return;
        }

        reports.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${r.reconciliation_number ? '#' + r.reconciliation_number : '-'}</td>
                <td>${formatDate(r.reconciliation_date)}</td>
                <td>${r.cashier_name || '-'}</td>
                <td>${r.accountant_name || '-'}</td>
                <td style="color: var(--success); font-weight: bold;">${formatCurrency(r.total_receipts)}</td>
                <td>${formatCurrency(r.system_sales)}</td>
                <td><span class="badge ${r.status === 'completed' ? 'badge-success' : 'badge-warning'}">${r.status === 'completed' ? 'مكتملة' : 'مسودة'}</span></td>
                <td class="text-end">
                    <button onclick="viewDetails(${r.id})" class="btn" style="width: auto; padding: 0.25rem 0.5rem; font-size: 0.8rem;">عرض</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--danger);">خطأ في التحميل</td></tr>';
    }
}

async function viewDetails(id) {
    const modal = document.getElementById('detailsModal');
    const content = document.getElementById('modalContent');

    modal.style.display = 'flex';
    content.innerHTML = 'جاري التحميل...';

    try {
        const data = await api.get(`/api/reports/${id}`);

        let bankHtml = '';
        if (data.bankReceipts && data.bankReceipts.length > 0) {
            data.bankReceipts.forEach(b => {
                bankHtml += `
                    <div style="display: flex; justify-content: space-between; padding: 0.5rem; border-bottom: 1px solid var(--border);">
                        <span>${b.bank_name || 'عملية بنكية'}</span>
                        <span>${formatCurrency(b.amount)}</span>
                    </div>
                `;
            });
        }

        content.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <div>
                    <label>الرقم التسلسلي</label>
                    <div style="font-weight: bold;">#${data.reconciliation_number || '-'}</div>
                </div>
                <div>
                    <label>التاريخ</label>
                    <div style="font-weight: bold;">${formatDate(data.reconciliation_date)}</div>
                </div>
                <div>
                    <label>الكاشير</label>
                    <div style="font-weight: bold;">${data.cashier_name}</div>
                </div>
                <div>
                    <label>المحاسب</label>
                    <div style="font-weight: bold;">${data.accountant_name}</div>
                </div>
            </div>

            <h3 style="margin-top: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">ملخص مالي</h3>
            <div style="background: var(--bg-primary); padding: 1rem; border-radius: 0.5rem; margin-top: 0.5rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span>مبيعات النظام:</span>
                    <span style="font-weight: bold;">${formatCurrency(data.system_sales)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span>إجمالي المقبوضات:</span>
                    <span style="font-weight: bold; color: var(--success);">${formatCurrency(data.total_receipts)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 0.5rem;">
                    <span>العجز/الفائض:</span>
                    <span style="font-weight: bold; color: ${data.surplus_deficit >= 0 ? 'var(--success)' : 'var(--danger)'};">
                        ${formatCurrency(data.surplus_deficit)}
                    </span>
                </div>
            </div>

            <h3 style="margin-top: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">المقبوضات البنكية</h3>
            <div style="background: var(--bg-primary); border-radius: 0.5rem; margin-top: 0.5rem;">
                ${bankHtml || '<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">لا توجد مقبوضات بنكية</div>'}
            </div>
        `;

    } catch (err) {
        content.innerHTML = 'حدث خطأ في جلب التفاصيل';
    }
}

function closeModal() {
    document.getElementById('detailsModal').style.display = 'none';
}

// Init
loadStats();
loadMetadata(); // New call
loadReports();
