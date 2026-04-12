import { useState, useMemo } from 'react';
import { useApi } from '../../hooks/useApi';
import {
  getOffers, createOffer, updateOffer,
  getPurchaseRequests, declinePurchaseRequest,
  getOrders, createManualOrder, confirmPayment,
  grantEntitlement, revokeEntitlement, getEntitlements,
  getAdminCourses, getAdminDraft,
} from '../../api/client';
import { Button, Badge, Spinner, Modal, Input, Textarea, Select, EmptyState, StudentPicker } from '../../components/ui';
import { formatPrice, formatDate, formatDateTime } from '../../utils/format';
import { generateIdempotencyKey } from '../../utils/format';
import type { CommercialOffer, PurchaseRequest, CommercialOrder, AdminCourse, Entitlement, CourseDraft } from '../../api/types';
import styles from './Commerce.module.css';

type Tab = 'offers' | 'requests' | 'orders' | 'entitlements';

const TAB_LABELS: Record<Tab, string> = {
  offers: 'Тарифы',
  requests: 'Заявки',
  orders: 'Заказы',
  entitlements: 'Доступы',
};

/* ========= Lesson Select (shared helper) ========= */
function LessonSelect({ courseId, value, onChange }: { courseId: string; value: string; onChange: (v: string) => void }) {
  const { data } = useApi<CourseDraft>(
    () => courseId ? getAdminDraft(courseId) : Promise.resolve(null as never),
    [courseId]
  );
  const lessons = useMemo(() => {
    if (!data?.content_json?.modules) return [];
    return data.content_json.modules.flatMap(m =>
      m.lessons.map(l => ({ id: l.id, title: `${m.title} → ${l.title}` }))
    );
  }, [data]);

  return (
    <Select label="Урок" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— Выберите урок —</option>
      {lessons.map(l => (
        <option key={l.id} value={l.id}>{l.title}</option>
      ))}
    </Select>
  );
}

/* ========= Тарифы (Offers) Tab ========= */
function OffersTab() {
  const { data, loading, error, reload } = useApi<CommercialOffer[]>(() => getOffers(), []);
  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<CommercialOffer | null>(null);

  const [cTargetType, setCTargetType] = useState<'course' | 'lesson'>('course');
  const [cCourseId, setCCourseId] = useState('');
  const [cLessonId, setCLessonId] = useState('');
  const [cTitle, setCTitle] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cPrice, setCPrice] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');

  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [ePrice, setEPrice] = useState('');
  const [eStatus, setEStatus] = useState<string>('');

  function resetCreate() {
    setCTargetType('course'); setCCourseId(''); setCLessonId('');
    setCTitle(''); setCDesc(''); setCPrice(''); setFormError('');
  }

  function openEdit(offer: CommercialOffer) {
    setShowEdit(offer);
    setETitle(offer.title); setEDesc(offer.description);
    setEPrice((offer.price_amount_minor / 100).toString());
    setEStatus(offer.status); setFormError('');
  }

  async function handleCreate() {
    setFormLoading(true); setFormError('');
    try {
      const body: Record<string, unknown> = {
        target_type: cTargetType, target_course_id: cCourseId,
        title: cTitle.trim(), description: cDesc.trim(),
        price_amount_minor: Math.round(Number(cPrice) * 100), price_currency: 'RUB',
      };
      if (cTargetType === 'lesson' && cLessonId) body.target_lesson_id = cLessonId;
      await createOffer(body);
      setShowCreate(false); resetCreate(); reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ошибка');
    } finally { setFormLoading(false); }
  }

  async function handleUpdate() {
    if (!showEdit) return;
    setFormLoading(true); setFormError('');
    try {
      await updateOffer(showEdit.offer_id, {
        title: eTitle.trim(), description: eDesc.trim(),
        price_amount_minor: Math.round(Number(ePrice) * 100),
        price_currency: showEdit.price_currency || 'RUB', status: eStatus,
      });
      setShowEdit(null); reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ошибка');
    } finally { setFormLoading(false); }
  }

  async function handleArchive(offer: CommercialOffer) {
    try {
      await updateOffer(offer.offer_id, {
        title: offer.title, description: offer.description,
        price_amount_minor: offer.price_amount_minor,
        price_currency: offer.price_currency || 'RUB', status: 'archived',
      });
      reload();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Ошибка');
    }
  }

  function statusBadge(status: string) {
    if (status === 'active') return <Badge color="lime">Активный</Badge>;
    if (status === 'archived') return <Badge color="gray">Архив</Badge>;
    return <Badge color="yellow">Черновик</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <>
      <div className={styles.toolbar}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>
          {data?.length ?? 0} тарифов
        </span>
        <Button size="sm" onClick={() => { setShowCreate(true); resetCreate(); }}>Создать тариф</Button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {formError && !showCreate && !showEdit && <div className={styles.error}>{formError}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="🏷️" title="Нет тарифов" description="Создайте первый платный тариф для курса или урока" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Курс / Урок</th>
              <th>Цена</th>
              <th>Статус</th>
              <th>Создан</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {data.map(o => (
              <tr key={o.offer_id}>
                <td className={styles.cellBold}>{o.title}</td>
                <td><Badge color={o.target_type === 'course' ? 'blue' : 'orange'}>{o.target_type === 'course' ? 'Курс' : 'Урок'}</Badge></td>
                <td>{o.course_title}{o.lesson_title ? ` / ${o.lesson_title}` : ''}</td>
                <td className={styles.cellBold}>{formatPrice(o.price_amount_minor, o.price_currency)}</td>
                <td>{statusBadge(o.status)}</td>
                <td>{formatDate(o.created_at)}</td>
                <td>
                  <div className={styles.cellActions}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(o)}>Изменить</Button>
                    {o.status !== 'archived' && (
                      <Button size="sm" variant="ghost" onClick={() => handleArchive(o)}>В архив</Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новый тариф">
        <div className={styles.modalForm}>
          <Select label="Тип цели" value={cTargetType} onChange={e => setCTargetType(e.target.value as 'course' | 'lesson')}>
            <option value="course">Курс</option>
            <option value="lesson">Урок</option>
          </Select>
          <Select label="Курс" value={cCourseId} onChange={e => { setCCourseId(e.target.value); setCLessonId(''); }}>
            <option value="">— Выберите курс —</option>
            {(courses.data ?? []).map(c => (
              <option key={c.course_id} value={c.course_id}>{c.title}</option>
            ))}
          </Select>
          {cTargetType === 'lesson' && (
            <LessonSelect courseId={cCourseId} value={cLessonId} onChange={setCLessonId} />
          )}
          <Input label="Название тарифа" value={cTitle} onChange={e => setCTitle(e.target.value)} />
          <Textarea label="Описание" value={cDesc} onChange={e => setCDesc(e.target.value)} rows={2} />
          <Input label="Цена (руб)" type="number" value={cPrice} onChange={e => setCPrice(e.target.value)} min={0} step={1} />
          {formError && <div className={styles.error}>{formError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>Отмена</Button>
            <Button onClick={handleCreate} loading={formLoading} disabled={!cTitle.trim() || !cCourseId || !cPrice}>
              Создать
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showEdit !== null} onClose={() => setShowEdit(null)} title="Редактировать тариф">
        <div className={styles.modalForm}>
          <Input label="Название" value={eTitle} onChange={e => setETitle(e.target.value)} />
          <Textarea label="Описание" value={eDesc} onChange={e => setEDesc(e.target.value)} rows={2} />
          <Input label="Цена (руб)" type="number" value={ePrice} onChange={e => setEPrice(e.target.value)} min={0} step={1} />
          <Select label="Статус" value={eStatus} onChange={e => setEStatus(e.target.value)}>
            <option value="draft">Черновик</option>
            <option value="active">Активный</option>
            <option value="archived">Архив</option>
          </Select>
          {formError && <div className={styles.error}>{formError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowEdit(null)}>Отмена</Button>
            <Button onClick={handleUpdate} loading={formLoading} disabled={!eTitle.trim() || !ePrice}>Сохранить</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Заявки (Purchase Requests) Tab ========= */
function RequestsTab() {
  const { data, loading, error, reload } = useApi<PurchaseRequest[]>(() => getPurchaseRequests(), []);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [showCreateOrder, setShowCreateOrder] = useState<PurchaseRequest | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);

  async function handleDecline(req: PurchaseRequest) {
    setActionLoading(req.request_id); setActionError('');
    try { await declinePurchaseRequest(req.request_id); reload(); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setActionLoading(null); }
  }

  async function handleCreateOrderFromRequest(req: PurchaseRequest) {
    setOrderLoading(true); setActionError('');
    try {
      await createManualOrder({ student_id: req.student_id, offer_id: req.offer_id, purchase_request_id: req.request_id });
      setShowCreateOrder(null); reload();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setOrderLoading(false); }
  }

  function statusBadge(status: string) {
    if (status === 'open') return <Badge color="yellow">Открыта</Badge>;
    if (status === 'processed') return <Badge color="lime">Обработана</Badge>;
    return <Badge color="gray">Отклонена</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <>
      {error && <div className={styles.error}>{error}</div>}
      {actionError && <div className={styles.error}>{actionError}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="📝" title="Нет заявок" description="Когда ученик запросит покупку — заявка появится здесь" />
      ) : (
        <table className={styles.table}>
          <thead><tr><th>Ученик</th><th>Тариф</th><th>Тип</th><th>Создана</th><th>Статус</th><th>Действия</th></tr></thead>
          <tbody>
            {data.map(r => (
              <tr key={r.request_id}>
                <td className={styles.cellBold}>{r.student_name}</td>
                <td>{r.offer_title}</td>
                <td><Badge color={r.target_type === 'course' ? 'blue' : 'orange'}>{r.target_type === 'course' ? 'Курс' : 'Урок'}</Badge></td>
                <td>{formatDateTime(r.created_at)}</td>
                <td>{statusBadge(r.status)}</td>
                <td>
                  {r.status === 'open' && (
                    <div className={styles.cellActions}>
                      <Button size="sm" onClick={() => setShowCreateOrder(r)}>Создать заказ</Button>
                      <Button size="sm" variant="danger" onClick={() => handleDecline(r)} loading={actionLoading === r.request_id}>Отклонить</Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={showCreateOrder !== null} onClose={() => setShowCreateOrder(null)} title="Создать заказ из заявки">
        {showCreateOrder && (
          <div className={styles.modalForm}>
            <div className={styles.detailGrid}>
              <span className={styles.detailLabel}>Ученик</span>
              <span className={styles.detailValue}>{showCreateOrder.student_name}</span>
              <span className={styles.detailLabel}>Тариф</span>
              <span className={styles.detailValue}>{showCreateOrder.offer_title}</span>
            </div>
            {actionError && <div className={styles.error}>{actionError}</div>}
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setShowCreateOrder(null)}>Отмена</Button>
              <Button onClick={() => handleCreateOrderFromRequest(showCreateOrder)} loading={orderLoading}>Подтвердить</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/* ========= Заказы (Orders) Tab ========= */
function OrdersTab() {
  const { data, loading, error, reload } = useApi<CommercialOrder[]>(() => getOrders(), []);
  const offers = useApi<CommercialOffer[]>(() => getOffers(), []);

  const [selectedOrder, setSelectedOrder] = useState<CommercialOrder | null>(null);
  const [showManualCreate, setShowManualCreate] = useState(false);
  const [actionError, setActionError] = useState('');

  const [confirmRef, setConfirmRef] = useState('');
  const [confirmAmount, setConfirmAmount] = useState('');
  const [confirmReason, setConfirmReason] = useState('');
  const [confirmLoading, setConfirmLoading] = useState(false);

  const [manualStudentId, setManualStudentId] = useState('');
  const [manualStudentName, setManualStudentName] = useState('');
  const [manualOfferId, setManualOfferId] = useState('');
  const [manualLoading, setManualLoading] = useState(false);

  function openOrder(order: CommercialOrder) {
    setSelectedOrder(order); setConfirmRef('');
    setConfirmAmount((order.price_amount_minor / 100).toString());
    setConfirmReason(''); setActionError('');
  }

  async function handleConfirmPayment() {
    if (!selectedOrder || !confirmRef.trim()) return;
    setConfirmLoading(true); setActionError('');
    try {
      const key = generateIdempotencyKey();
      const reason = confirmReason.trim();
      await confirmPayment(selectedOrder.order_id, {
        external_reference: confirmRef.trim(),
        amount_minor: Math.round(Number(confirmAmount) * 100),
        currency: selectedOrder.price_currency || 'RUB',
        paid_at: new Date().toISOString(),
        ...(reason ? { override: { reason } } : {}),
      }, key);
      setSelectedOrder(null); reload();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setConfirmLoading(false); }
  }

  async function handleManualCreate() {
    if (!manualStudentId.trim() || !manualOfferId) return;
    setManualLoading(true); setActionError('');
    try {
      await createManualOrder({ student_id: manualStudentId.trim(), offer_id: manualOfferId });
      setShowManualCreate(false); setManualStudentId(''); setManualStudentName(''); setManualOfferId('');
      reload();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setManualLoading(false); }
  }

  function orderStatusBadge(status: string) {
    if (status === 'awaiting_confirmation') return <Badge color="yellow">Ожидает оплаты</Badge>;
    if (status === 'fulfilled') return <Badge color="lime">Выполнен</Badge>;
    return <Badge color="red">Отменён</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <>
      <div className={styles.toolbar}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>{data?.length ?? 0} заказов</span>
        <Button size="sm" onClick={() => { setShowManualCreate(true); setActionError(''); }}>Создать заказ вручную</Button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="📦" title="Нет заказов" description="Заказы появятся после создания из заявки или вручную" />
      ) : (
        <table className={styles.table}>
          <thead><tr><th>Ученик</th><th>Тариф</th><th>Сумма</th><th>Статус</th><th>Создан</th></tr></thead>
          <tbody>
            {data.map(o => (
              <tr key={o.order_id} className={styles.clickable} onClick={() => openOrder(o)}>
                <td className={styles.cellBold}>{o.student_name}</td>
                <td>{o.offer_title}</td>
                <td className={styles.cellBold}>{formatPrice(o.price_amount_minor, o.price_currency)}</td>
                <td>{orderStatusBadge(o.status)}</td>
                <td>{formatDateTime(o.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={selectedOrder !== null} onClose={() => setSelectedOrder(null)} title="Детали заказа">
        {selectedOrder && (
          <div className={styles.modalForm}>
            <div className={styles.detailGrid}>
              <span className={styles.detailLabel}>ID заказа</span>
              <span className={styles.detailValue}>{selectedOrder.order_id}</span>
              <span className={styles.detailLabel}>Ученик</span>
              <span className={styles.detailValue}>{selectedOrder.student_name}</span>
              <span className={styles.detailLabel}>Тариф</span>
              <span className={styles.detailValue}>{selectedOrder.offer_title}</span>
              <span className={styles.detailLabel}>Тип</span>
              <span className={styles.detailValue}>{selectedOrder.target_type === 'course' ? 'Курс' : 'Урок'}</span>
              <span className={styles.detailLabel}>Сумма</span>
              <span className={styles.detailValue}>{formatPrice(selectedOrder.price_amount_minor, selectedOrder.price_currency)}</span>
              <span className={styles.detailLabel}>Статус</span>
              <span className={styles.detailValue}>{orderStatusBadge(selectedOrder.status)}</span>
              <span className={styles.detailLabel}>Создан</span>
              <span className={styles.detailValue}>{formatDateTime(selectedOrder.created_at)}</span>
              {selectedOrder.fulfilled_at && (<>
                <span className={styles.detailLabel}>Выполнен</span>
                <span className={styles.detailValue}>{formatDateTime(selectedOrder.fulfilled_at)}</span>
              </>)}
            </div>
            {selectedOrder.status === 'awaiting_confirmation' && (
              <div className={styles.confirmSection}>
                <div className={styles.confirmTitle}>Подтвердить оплату</div>
                <Input label="Внешняя ссылка (обязательно)" value={confirmRef} onChange={e => setConfirmRef(e.target.value)} placeholder="ID транзакции, номер квитанции..." />
                <Input label="Сумма подтверждения (руб)" type="number" value={confirmAmount} onChange={e => setConfirmAmount(e.target.value)} min={0} step={1} />
                <Input label="Причина (необязательно)" value={confirmReason} onChange={e => setConfirmReason(e.target.value)} placeholder="Если сумма отличается от ожидаемой..." />
                {actionError && <div className={styles.error}>{actionError}</div>}
                <Button variant="success" onClick={handleConfirmPayment} loading={confirmLoading} disabled={!confirmRef.trim()}>
                  Подтвердить оплату
                </Button>
              </div>
            )}
            {selectedOrder.status !== 'awaiting_confirmation' && actionError && <div className={styles.error}>{actionError}</div>}
          </div>
        )}
      </Modal>

      <Modal open={showManualCreate} onClose={() => setShowManualCreate(false)} title="Создать заказ вручную">
        <div className={styles.modalForm}>
          <StudentPicker
            label="Ученик"
            value={manualStudentId}
            displayValue={manualStudentName}
            onChange={(id, name) => { setManualStudentId(id); setManualStudentName(name); }}
          />
          <Select label="Тариф" value={manualOfferId} onChange={e => setManualOfferId(e.target.value)}>
            <option value="">— Выберите тариф —</option>
            {(offers.data ?? []).filter(o => o.status === 'active').map(o => (
              <option key={o.offer_id} value={o.offer_id}>{o.title} — {formatPrice(o.price_amount_minor, o.price_currency)}</option>
            ))}
          </Select>
          {actionError && <div className={styles.error}>{actionError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowManualCreate(false)}>Отмена</Button>
            <Button onClick={handleManualCreate} loading={manualLoading} disabled={!manualStudentId.trim() || !manualOfferId}>Создать заказ</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Доступы (Entitlements) Tab ========= */
function EntitlementsTab() {
  const [filterStatus, setFilterStatus] = useState('');
  const [filterStudentId, setFilterStudentId] = useState('');
  const [filterStudentName, setFilterStudentName] = useState('');

  const { data, loading, error, reload } = useApi<Entitlement[]>(
    () => getEntitlements({
      student_id: filterStudentId || undefined,
      status: filterStatus || undefined,
    }),
    [filterStudentId, filterStatus]
  );
  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);

  const [showGrant, setShowGrant] = useState(false);
  const [grantStudentId, setGrantStudentId] = useState('');
  const [grantStudentName, setGrantStudentName] = useState('');
  const [grantTargetType, setGrantTargetType] = useState<'course' | 'lesson'>('course');
  const [grantCourseId, setGrantCourseId] = useState('');
  const [grantLessonId, setGrantLessonId] = useState('');
  const [grantLoading, setGrantLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [actionError, setActionError] = useState('');
  const [revokeLoading, setRevokeLoading] = useState<string | null>(null);

  async function handleGrant() {
    if (!grantStudentId.trim() || !grantCourseId) return;
    setGrantLoading(true); setActionError(''); setSuccessMsg('');
    try {
      const body: Record<string, unknown> = {
        student_id: grantStudentId.trim(),
        target_type: grantTargetType,
        target_course_id: grantCourseId,
      };
      if (grantTargetType === 'lesson' && grantLessonId) body.target_lesson_id = grantLessonId;
      await grantEntitlement(body);
      setSuccessMsg('Доступ успешно выдан!');
      setShowGrant(false);
      setGrantStudentId(''); setGrantStudentName(''); setGrantCourseId(''); setGrantLessonId('');
      reload();
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setGrantLoading(false); }
  }

  async function handleRevoke(entitlementId: string) {
    setRevokeLoading(entitlementId); setActionError(''); setSuccessMsg('');
    try {
      await revokeEntitlement(entitlementId);
      setSuccessMsg('Доступ отозван');
      reload();
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Ошибка'); }
    finally { setRevokeLoading(null); }
  }

  function statusBadge(status: string) {
    if (status === 'active') return <Badge color="lime">Активен</Badge>;
    return <Badge color="red">Отозван</Badge>;
  }

  function sourceBadge(source: string) {
    if (source === 'purchase') return <Badge color="blue">Покупка</Badge>;
    return <Badge color="orange">Бесплатный</Badge>;
  }

  return (
    <>
      {successMsg && <div className={styles.success}>{successMsg}</div>}
      {actionError && <div className={styles.error}>{actionError}</div>}

      <div className={styles.toolbar}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>
          {data?.length ?? 0} доступов
        </span>
        <Button size="sm" onClick={() => { setShowGrant(true); setActionError(''); setSuccessMsg(''); }}>
          Выдать доступ
        </Button>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterItem}>
          <Select label="Статус" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">Все</option>
            <option value="active">Активные</option>
            <option value="revoked">Отозванные</option>
          </Select>
        </div>
        <div className={styles.filterItem}>
          <StudentPicker
            label="Ученик"
            value={filterStudentId}
            displayValue={filterStudentName}
            onChange={(id, name) => { setFilterStudentId(id); setFilterStudentName(name); }}
            placeholder="Фильтр по ученику…"
          />
          {filterStudentId && (
            <button
              className={styles.clearFilter}
              onClick={() => { setFilterStudentId(''); setFilterStudentName(''); }}
              type="button"
            >
              ✕ Сбросить
            </button>
          )}
        </div>
      </div>

      {loading ? <Spinner /> : error ? <div className={styles.error}>{error}</div> : (!data || data.length === 0) ? (
        <EmptyState icon="🔑" title="Нет доступов" description="Доступы появятся после оплаты тарифа или ручной выдачи" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ученик</th>
              <th>Тип</th>
              <th>Курс</th>
              <th>Источник</th>
              <th>Статус</th>
              <th>Выдан</th>
              <th>Кем</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {data.map(e => (
              <tr key={e.entitlement_id}>
                <td className={styles.cellBold}>{e.student_name}</td>
                <td><Badge color={e.target_type === 'course' ? 'blue' : 'orange'}>{e.target_type === 'course' ? 'Курс' : 'Урок'}</Badge></td>
                <td>{e.course_title}</td>
                <td>{sourceBadge(e.source_type)}</td>
                <td>{statusBadge(e.status)}</td>
                <td>{formatDateTime(e.granted_at)}</td>
                <td>{e.granted_by_name}</td>
                <td>
                  {e.status === 'active' && (
                    <Button size="sm" variant="danger" onClick={() => handleRevoke(e.entitlement_id)} loading={revokeLoading === e.entitlement_id}>
                      Отозвать
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={showGrant} onClose={() => setShowGrant(false)} title="Выдать доступ">
        <div className={styles.modalForm}>
          <StudentPicker
            label="Ученик"
            value={grantStudentId}
            displayValue={grantStudentName}
            onChange={(id, name) => { setGrantStudentId(id); setGrantStudentName(name); }}
          />
          <Select label="Тип цели" value={grantTargetType} onChange={e => setGrantTargetType(e.target.value as 'course' | 'lesson')}>
            <option value="course">Курс</option>
            <option value="lesson">Урок</option>
          </Select>
          <Select label="Курс" value={grantCourseId} onChange={e => { setGrantCourseId(e.target.value); setGrantLessonId(''); }}>
            <option value="">— Выберите курс —</option>
            {(courses.data ?? []).map(c => (
              <option key={c.course_id} value={c.course_id}>{c.title}</option>
            ))}
          </Select>
          {grantTargetType === 'lesson' && (
            <LessonSelect courseId={grantCourseId} value={grantLessonId} onChange={setGrantLessonId} />
          )}
          {actionError && <div className={styles.error}>{actionError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowGrant(false)}>Отмена</Button>
            <Button onClick={handleGrant} loading={grantLoading} disabled={!grantStudentId.trim() || !grantCourseId}>Выдать</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Main Commerce Page ========= */
export default function Commerce() {
  const [tab, setTab] = useState<Tab>('offers');
  const [helpOpen, setHelpOpen] = useState(() => localStorage.getItem('commerce_help_dismissed') !== 'true');

  function dismissHelp() {
    setHelpOpen(false);
    localStorage.setItem('commerce_help_dismissed', 'true');
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Коммерция</h1>
      </div>

      {helpOpen && (
        <div className={styles.onboarding}>
          <div className={styles.onboardingHeader}>
            <span className={styles.onboardingTitle}>Как работает монетизация</span>
            <Button size="sm" variant="ghost" onClick={dismissHelp}>Скрыть</Button>
          </div>
          <div className={styles.onboardingSteps}>
            <div className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <span><b>Тариф</b> — создайте платное предложение для курса или урока</span>
            </div>
            <span className={styles.stepArrow}>→</span>
            <div className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <span><b>Заявка</b> — ученик запрашивает покупку</span>
            </div>
            <span className={styles.stepArrow}>→</span>
            <div className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <span><b>Заказ</b> — создайте заказ из заявки или вручную</span>
            </div>
            <span className={styles.stepArrow}>→</span>
            <div className={styles.step}>
              <span className={styles.stepNumber}>4</span>
              <span><b>Оплата</b> — подтвердите получение денег</span>
            </div>
            <span className={styles.stepArrow}>→</span>
            <div className={styles.step}>
              <span className={styles.stepNumber}>5</span>
              <span><b>Доступ</b> — ученик получает доступ к контенту</span>
            </div>
          </div>
        </div>
      )}

      <div className={styles.tabs}>
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'offers' && <OffersTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'orders' && <OrdersTab />}
      {tab === 'entitlements' && <EntitlementsTab />}
    </div>
  );
}
