import { useState, useCallback } from 'react';
import { useApi } from '../../hooks/useApi';
import {
  getOffers, createOffer, updateOffer,
  getPurchaseRequests, declinePurchaseRequest,
  getOrders, createManualOrder, confirmPayment,
  grantEntitlement, revokeEntitlement,
  getAdminCourses,
} from '../../api/client';
import { Button, Badge, Spinner, Modal, Input, Textarea, Select, EmptyState } from '../../components/ui';
import { formatPrice, formatDate, formatDateTime } from '../../utils/format';
import { generateIdempotencyKey } from '../../utils/format';
import type { CommercialOffer, PurchaseRequest, CommercialOrder, AdminCourse } from '../../api/types';
import styles from './Commerce.module.css';

type Tab = 'offers' | 'requests' | 'orders' | 'entitlements';

const TAB_LABELS: Record<Tab, string> = {
  offers: 'Офферы',
  requests: 'Заявки',
  orders: 'Заказы',
  entitlements: 'Доступы',
};

/* ========= Offers Tab ========= */
function OffersTab() {
  const { data, loading, error, reload } = useApi<CommercialOffer[]>(() => getOffers(), []);
  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState<CommercialOffer | null>(null);

  // Create form state
  const [cTargetType, setCTargetType] = useState<'course' | 'lesson'>('course');
  const [cCourseId, setCCourseId] = useState('');
  const [cLessonId, setCLessonId] = useState('');
  const [cTitle, setCTitle] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cPrice, setCPrice] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');

  // Edit form state
  const [eTitle, setETitle] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [ePrice, setEPrice] = useState('');
  const [eStatus, setEStatus] = useState<string>('');

  function resetCreate() {
    setCTargetType('course');
    setCCourseId('');
    setCLessonId('');
    setCTitle('');
    setCDesc('');
    setCPrice('');
    setFormError('');
  }

  function openEdit(offer: CommercialOffer) {
    setShowEdit(offer);
    setETitle(offer.title);
    setEDesc(offer.description);
    setEPrice((offer.price_amount_minor / 100).toString());
    setEStatus(offer.status);
    setFormError('');
  }

  async function handleCreate() {
    setFormLoading(true);
    setFormError('');
    try {
      const body: Record<string, unknown> = {
        target_type: cTargetType,
        target_course_id: cCourseId,
        title: cTitle.trim(),
        description: cDesc.trim(),
        price_amount_minor: Math.round(Number(cPrice) * 100),
        price_currency: 'RUB',
      };
      if (cTargetType === 'lesson' && cLessonId) {
        body.target_lesson_id = cLessonId;
      }
      await createOffer(body);
      setShowCreate(false);
      resetCreate();
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setFormLoading(false);
    }
  }

  async function handleUpdate() {
    if (!showEdit) return;
    setFormLoading(true);
    setFormError('');
    try {
      await updateOffer(showEdit.offer_id, {
        title: eTitle.trim(),
        description: eDesc.trim(),
        price_amount_minor: Math.round(Number(ePrice) * 100),
        price_currency: showEdit.price_currency || 'RUB',
        status: eStatus,
      });
      setShowEdit(null);
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setFormLoading(false);
    }
  }

  async function handleArchive(offer: CommercialOffer) {
    try {
      await updateOffer(offer.offer_id, {
        title: offer.title,
        description: offer.description,
        price_amount_minor: offer.price_amount_minor,
        price_currency: offer.price_currency || 'RUB',
        status: 'archived',
      });
      reload();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Ошибка архивации оффера');
    }
  }

  function offerStatusBadge(status: string) {
    if (status === 'active') return <Badge color="lime">Активный</Badge>;
    if (status === 'archived') return <Badge color="gray">Архив</Badge>;
    return <Badge color="yellow">Черновик</Badge>;
  }

  if (loading) return <Spinner />;

  return (
    <>
      <div className={styles.toolbar}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>
          {data?.length ?? 0} офферов
        </span>
        <Button size="sm" onClick={() => { setShowCreate(true); resetCreate(); }}>Создать оффер</Button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {formError && !showCreate && !showEdit && <div className={styles.error}>{formError}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="🏷️" title="Нет офферов" description="Создайте первый коммерческий оффер" />
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
                <td>{offerStatusBadge(o.status)}</td>
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

      {/* Create Offer Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Новый оффер">
        <div className={styles.modalForm}>
          <Select label="Тип цели" value={cTargetType} onChange={e => setCTargetType(e.target.value as 'course' | 'lesson')}>
            <option value="course">Курс</option>
            <option value="lesson">Урок</option>
          </Select>
          <Select label="Курс" value={cCourseId} onChange={e => setCCourseId(e.target.value)}>
            <option value="">-- Выберите курс --</option>
            {(courses.data ?? []).map(c => (
              <option key={c.course_id} value={c.course_id}>{c.title}</option>
            ))}
          </Select>
          {cTargetType === 'lesson' && (
            <Input
              label="ID урока"
              value={cLessonId}
              onChange={e => setCLessonId(e.target.value)}
              placeholder="ID урока из курса"
            />
          )}
          <Input label="Название оффера" value={cTitle} onChange={e => setCTitle(e.target.value)} />
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

      {/* Edit Offer Modal */}
      <Modal open={showEdit !== null} onClose={() => setShowEdit(null)} title="Редактировать оффер">
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
            <Button onClick={handleUpdate} loading={formLoading} disabled={!eTitle.trim() || !ePrice}>
              Сохранить
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Purchase Requests Tab ========= */
function RequestsTab() {
  const { data, loading, error, reload } = useApi<PurchaseRequest[]>(() => getPurchaseRequests(), []);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  // For creating order from a request
  const [showCreateOrder, setShowCreateOrder] = useState<PurchaseRequest | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);

  async function handleDecline(req: PurchaseRequest) {
    setActionLoading(req.request_id);
    setActionError('');
    try {
      await declinePurchaseRequest(req.request_id);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCreateOrderFromRequest(req: PurchaseRequest) {
    setOrderLoading(true);
    setActionError('');
    try {
      await createManualOrder({
        student_id: req.student_id,
        offer_id: req.offer_id,
        source: 'purchase_request',
        request_id: req.request_id,
      });
      setShowCreateOrder(null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setOrderLoading(false);
    }
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
        <EmptyState icon="📝" title="Нет заявок" description="Заявки на покупку появятся здесь" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ученик</th>
              <th>Оффер</th>
              <th>Тип</th>
              <th>Создана</th>
              <th>Статус</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => (
              <tr key={r.request_id}>
                <td className={styles.cellBold}>{r.student_name}</td>
                <td>{r.offer_title}</td>
                <td><Badge color="gray">{r.target_type === 'course' ? 'Курс' : 'Урок'}</Badge></td>
                <td>{formatDateTime(r.created_at)}</td>
                <td>{statusBadge(r.status)}</td>
                <td>
                  {r.status === 'open' && (
                    <div className={styles.cellActions}>
                      <Button
                        size="sm"
                        onClick={() => setShowCreateOrder(r)}
                      >
                        Создать заказ
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => handleDecline(r)}
                        loading={actionLoading === r.request_id}
                      >
                        Отклонить
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={showCreateOrder !== null}
        onClose={() => setShowCreateOrder(null)}
        title="Создать заказ из заявки"
      >
        {showCreateOrder && (
          <div className={styles.modalForm}>
            <div className={styles.detailGrid}>
              <span className={styles.detailLabel}>Ученик</span>
              <span className={styles.detailValue}>{showCreateOrder.student_name}</span>
              <span className={styles.detailLabel}>Оффер</span>
              <span className={styles.detailValue}>{showCreateOrder.offer_title}</span>
            </div>
            {actionError && <div className={styles.error}>{actionError}</div>}
            <div className={styles.modalActions}>
              <Button variant="secondary" onClick={() => setShowCreateOrder(null)}>Отмена</Button>
              <Button
                onClick={() => handleCreateOrderFromRequest(showCreateOrder)}
                loading={orderLoading}
              >
                Подтвердить
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/* ========= Orders Tab ========= */
function OrdersTab() {
  const { data, loading, error, reload } = useApi<CommercialOrder[]>(() => getOrders(), []);
  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);
  const offers = useApi<CommercialOffer[]>(() => getOffers(), []);

  const [selectedOrder, setSelectedOrder] = useState<CommercialOrder | null>(null);
  const [showManualCreate, setShowManualCreate] = useState(false);
  const [actionError, setActionError] = useState('');

  // Confirm payment form
  const [confirmRef, setConfirmRef] = useState('');
  const [confirmAmount, setConfirmAmount] = useState('');
  const [confirmReason, setConfirmReason] = useState('');
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Manual order form
  const [manualStudentId, setManualStudentId] = useState('');
  const [manualOfferId, setManualOfferId] = useState('');
  const [manualLoading, setManualLoading] = useState(false);

  function openOrder(order: CommercialOrder) {
    setSelectedOrder(order);
    setConfirmRef('');
    setConfirmAmount((order.price_amount_minor / 100).toString());
    setConfirmReason('');
    setActionError('');
  }

  async function handleConfirmPayment() {
    if (!selectedOrder || !confirmRef.trim()) return;
    setConfirmLoading(true);
    setActionError('');
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
      setSelectedOrder(null);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleManualCreate() {
    if (!manualStudentId.trim() || !manualOfferId) return;
    setManualLoading(true);
    setActionError('');
    try {
      await createManualOrder({
        student_id: manualStudentId.trim(),
        offer_id: manualOfferId,
        source: 'manual',
      });
      setShowManualCreate(false);
      setManualStudentId('');
      setManualOfferId('');
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setManualLoading(false);
    }
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
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>
          {data?.length ?? 0} заказов
        </span>
        <Button size="sm" onClick={() => { setShowManualCreate(true); setActionError(''); }}>
          Создать заказ вручную
        </Button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {(!data || data.length === 0) ? (
        <EmptyState icon="📦" title="Нет заказов" description="Заказы появятся здесь" />
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Ученик</th>
              <th>Оффер</th>
              <th>Сумма</th>
              <th>Статус</th>
              <th>Создан</th>
            </tr>
          </thead>
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

      {/* Order detail / confirm payment modal */}
      <Modal
        open={selectedOrder !== null}
        onClose={() => setSelectedOrder(null)}
        title="Заказ"
      >
        {selectedOrder && (
          <div className={styles.modalForm}>
            <div className={styles.detailGrid}>
              <span className={styles.detailLabel}>ID заказа</span>
              <span className={styles.detailValue}>{selectedOrder.order_id}</span>

              <span className={styles.detailLabel}>Ученик</span>
              <span className={styles.detailValue}>{selectedOrder.student_name}</span>

              <span className={styles.detailLabel}>Оффер</span>
              <span className={styles.detailValue}>{selectedOrder.offer_title}</span>

              <span className={styles.detailLabel}>Тип</span>
              <span className={styles.detailValue}>{selectedOrder.target_type === 'course' ? 'Курс' : 'Урок'}</span>

              <span className={styles.detailLabel}>Сумма</span>
              <span className={styles.detailValue}>{formatPrice(selectedOrder.price_amount_minor, selectedOrder.price_currency)}</span>

              <span className={styles.detailLabel}>Статус</span>
              <span className={styles.detailValue}>{orderStatusBadge(selectedOrder.status)}</span>

              <span className={styles.detailLabel}>Создан</span>
              <span className={styles.detailValue}>{formatDateTime(selectedOrder.created_at)}</span>

              {selectedOrder.fulfilled_at && (
                <>
                  <span className={styles.detailLabel}>Выполнен</span>
                  <span className={styles.detailValue}>{formatDateTime(selectedOrder.fulfilled_at)}</span>
                </>
              )}
            </div>

            {selectedOrder.status === 'awaiting_confirmation' && (
              <div className={styles.confirmSection}>
                <div className={styles.confirmTitle}>Подтвердить оплату</div>
                <Input
                  label="Внешняя ссылка (обязательно)"
                  value={confirmRef}
                  onChange={e => setConfirmRef(e.target.value)}
                  placeholder="ID транзакции, номер квитанции..."
                />
                <Input
                  label="Сумма подтверждения (руб)"
                  type="number"
                  value={confirmAmount}
                  onChange={e => setConfirmAmount(e.target.value)}
                  min={0}
                  step={1}
                />
                <Input
                  label="Причина (необязательно)"
                  value={confirmReason}
                  onChange={e => setConfirmReason(e.target.value)}
                  placeholder="Если сумма отличается от ожидаемой..."
                />
                {actionError && <div className={styles.error}>{actionError}</div>}
                <Button
                  variant="success"
                  onClick={handleConfirmPayment}
                  loading={confirmLoading}
                  disabled={!confirmRef.trim()}
                >
                  Подтвердить оплату
                </Button>
              </div>
            )}

            {selectedOrder.status !== 'awaiting_confirmation' && actionError && (
              <div className={styles.error}>{actionError}</div>
            )}
          </div>
        )}
      </Modal>

      {/* Manual create order modal */}
      <Modal
        open={showManualCreate}
        onClose={() => setShowManualCreate(false)}
        title="Создать заказ вручную"
      >
        <div className={styles.modalForm}>
          <Input
            label="ID ученика"
            value={manualStudentId}
            onChange={e => setManualStudentId(e.target.value)}
            placeholder="account_id ученика"
          />
          <Select label="Оффер" value={manualOfferId} onChange={e => setManualOfferId(e.target.value)}>
            <option value="">-- Выберите оффер --</option>
            {(offers.data ?? []).filter(o => o.status === 'active').map(o => (
              <option key={o.offer_id} value={o.offer_id}>
                {o.title} -- {formatPrice(o.price_amount_minor, o.price_currency)}
              </option>
            ))}
          </Select>
          {actionError && <div className={styles.error}>{actionError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowManualCreate(false)}>Отмена</Button>
            <Button
              onClick={handleManualCreate}
              loading={manualLoading}
              disabled={!manualStudentId.trim() || !manualOfferId}
            >
              Создать заказ
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Entitlements Tab ========= */
function EntitlementsTab() {
  const [showGrant, setShowGrant] = useState(false);
  const [grantStudentId, setGrantStudentId] = useState('');
  const [grantTargetType, setGrantTargetType] = useState<'course' | 'lesson'>('course');
  const [grantCourseId, setGrantCourseId] = useState('');
  const [grantLessonId, setGrantLessonId] = useState('');
  const [grantLoading, setGrantLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [actionError, setActionError] = useState('');

  const [revokeId, setRevokeId] = useState('');
  const [revokeLoading, setRevokeLoading] = useState(false);

  const courses = useApi<AdminCourse[]>(() => getAdminCourses(), []);

  async function handleGrant() {
    if (!grantStudentId.trim() || !grantCourseId) return;
    setGrantLoading(true);
    setActionError('');
    setSuccessMsg('');
    try {
      const body: Record<string, unknown> = {
        student_id: grantStudentId.trim(),
        target_type: grantTargetType,
        target_course_id: grantCourseId,
        source: 'complimentary',
      };
      if (grantTargetType === 'lesson' && grantLessonId) {
        body.target_lesson_id = grantLessonId;
      }
      await grantEntitlement(body);
      setSuccessMsg('Доступ выдан!');
      setShowGrant(false);
      setGrantStudentId('');
      setGrantCourseId('');
      setGrantLessonId('');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setGrantLoading(false);
    }
  }

  async function handleRevoke() {
    if (!revokeId.trim()) return;
    setRevokeLoading(true);
    setActionError('');
    setSuccessMsg('');
    try {
      await revokeEntitlement(revokeId.trim());
      setSuccessMsg('Доступ отозван!');
      setRevokeId('');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setRevokeLoading(false);
    }
  }

  return (
    <>
      {successMsg && <div className={styles.success}>{successMsg}</div>}
      {actionError && <div className={styles.error}>{actionError}</div>}

      <div className={styles.toolbar}>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--gray-500)' }}>
          Управление доступами
        </span>
        <Button size="sm" onClick={() => { setShowGrant(true); setActionError(''); }}>
          Выдать доступ
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 16 }}>
        <div style={{ background: 'var(--white)', border: 'var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-comic-sm)', padding: 24 }}>
          <div style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: 16 }}>Отозвать доступ</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <Input
              label="ID доступа (entitlement)"
              value={revokeId}
              onChange={e => setRevokeId(e.target.value)}
              placeholder="entitlement_id"
              style={{ flex: 1 }}
            />
            <Button variant="danger" onClick={handleRevoke} loading={revokeLoading} disabled={!revokeId.trim()}>
              Отозвать
            </Button>
          </div>
        </div>
      </div>

      {/* Grant entitlement modal */}
      <Modal open={showGrant} onClose={() => setShowGrant(false)} title="Выдать доступ">
        <div className={styles.modalForm}>
          <Input
            label="ID ученика"
            value={grantStudentId}
            onChange={e => setGrantStudentId(e.target.value)}
            placeholder="account_id ученика"
          />
          <Select
            label="Тип цели"
            value={grantTargetType}
            onChange={e => setGrantTargetType(e.target.value as 'course' | 'lesson')}
          >
            <option value="course">Курс</option>
            <option value="lesson">Урок</option>
          </Select>
          <Select label="Курс" value={grantCourseId} onChange={e => setGrantCourseId(e.target.value)}>
            <option value="">-- Выберите курс --</option>
            {(courses.data ?? []).map(c => (
              <option key={c.course_id} value={c.course_id}>{c.title}</option>
            ))}
          </Select>
          {grantTargetType === 'lesson' && (
            <Input
              label="ID урока"
              value={grantLessonId}
              onChange={e => setGrantLessonId(e.target.value)}
              placeholder="ID урока"
            />
          )}
          {actionError && <div className={styles.error}>{actionError}</div>}
          <div className={styles.modalActions}>
            <Button variant="secondary" onClick={() => setShowGrant(false)}>Отмена</Button>
            <Button
              onClick={handleGrant}
              loading={grantLoading}
              disabled={!grantStudentId.trim() || !grantCourseId}
            >
              Выдать
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/* ========= Main Commerce Page ========= */
export default function Commerce() {
  const [tab, setTab] = useState<Tab>('offers');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Коммерция</h1>
      </div>

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
