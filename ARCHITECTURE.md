# Право Просто — Архитектурные решения

Дата фиксации: 2026-03-06

Документ нужен для поэтапной фиксации архитектурных решений MVP. Это не финальная архитектура, а набор подтвержденных решений и ограничений, на которые дальше будет опираться HLD.

## Подход

- Целевой стек MVP: backend на Go, frontend на React.
- Базовый принцип: low coupling, high cohesion, расширяемость без преждевременного дробления на микросервисы.
- Базовая форма backend-архитектуры для MVP: модульный монолит с явными доменными границами.
- Решения в этом документе можно пересматривать, но изменения должны вноситься явно, чтобы не терять архитектурный контекст.

## Зафиксированные решения

### 1. Роли

- У одного аккаунта в MVP ровно одна рабочая роль.
- Поддерживаемые роли: `student`, `parent`, `teacher`, `admin`.
- На момент первого SSO-входа аккаунт может находиться в техническом состоянии `unselected` до завершения onboarding role selection.
- Возможность совмещать роли в одном аккаунте откладывается на будущее и не должна усложнять MVP-модель доступа.
- Роль `admin` не выбирается на публичном онбординге и назначается только административно.

### 2. Аутентификация

- Авторизация только через SSO.
- В MVP ребенок входит в систему через собственный SSO-аккаунт.
- В MVP не поддерживается локальная аутентификация по логину и паролю.
- После первого SSO-входа система может создать аккаунт без рабочей роли в состоянии `unselected`.
- Выбор роли после первого входа является одноразовой операцией и переводит аккаунт из `unselected` в одну из рабочих ролей.
- API выбора роли должен быть идемпотентным: повторный запрос с той же ролью возвращает успех без изменений, запрос с другой ролью отклоняется.

### 3. Ребенок и прохождение уроков

- Ребенок самостоятельно входит по SSO и сам проходит уроки.
- Родитель не проходит уроки от имени ребенка.
- Отдельный режим impersonation на стороне родителя в MVP не нужен.

### 4. Связь родитель ↔ ребенок

- Связь между родителями и детьми в MVP: many-to-many.
- У одного ребенка может быть не более двух родителей.
- Эта связь нужна уже в MVP и должна быть отражена в доменной модели и ACL.

### 5. Доступ к курсам учителя

- В MVP доступ по ссылке дает ученику доступ к курсу учителя.
- На данном этапе не фиксируем полноценную модель enrollment как обязательную бизнес-сущность.
- Архитектура должна позволять позже без слома перейти от "доступа" к "записи на курс", прогрессу по назначенным курсам, архивированию и удалению из списка.

### 6. Модель урока и ветвление

- Требование на текущий момент: поддержать нелинейный сценарий урока с ветвлением.
- Для HLD MVP урок фиксируется как граф шагов, а не как простой линейный список блоков.
- Формат графа для MVP: направленный ациклический граф (DAG), где:
  - шаг урока является узлом графа;
  - переход между шагами является ребром;
  - переход выбирается по результату ответа или по явно заданному правилу;
  - несколько веток могут сходиться в один общий следующий шаг;
  - циклы внутри опубликованного урока запрещены.
- Такой подход дает гибкость автору, но заметно проще для preview, прохождения, аналитики и валидации, чем произвольный граф с циклами.

### 7. Проверка свободных ответов через LLM

- Свободный ответ с LLM-проверкой является отдельным типом задания.
- Задания с выбором ответа не проверяются LLM.
- LLM-проверка входит в MVP как обязательная продуктовая возможность.

### 8. Результат LLM-проверки

- Проверка свободного ответа должна возвращать один из трех уровней оценки.
- Вместе с уровнем оценки система должна возвращать текстовую обратную связь.
- Это решение должно быть отражено и в доменной модели попытки, и в API ответа урока, и в UI экране фидбэка.

### 9. Геймификация MVP

- В MVP обязательны: `XP`, `hearts`, `badges`, `levels`.
- `streak` входит в MVP как облегченная механика, потому что он уже заложен в требования, UI и user stories.
- `daily goal` не входит в обязательный минимальный объем текущего MVP.
- Домен геймификации должен быть отделен от домена прохождения урока, чтобы правила начислений можно было менять независимо.

### 10. Продуктовый фокус MVP

- Для MVP важны оба направления:
  - B2C: родитель + ребенок;
  - B2B-lite: учитель + приватные курсы.
- Архитектура MVP не должна быть оптимизирована только под один из этих контуров.

### 11. Модерация курсов учителя

- Курсы учителя не публикуются автоматически.
- Публикация и доступ учеников возможны только после одобрения админом.
- Следовательно, в модели курса нужен жизненный цикл со статусами как минимум для черновика, отправки на модерацию, публикации и отклонения.
- Для платформенных курсов админа действует отдельный flow: админ может публиковать platform-owned курс без прохождения teacher moderation queue.

### 12. LLM-провайдер

- Система должна работать с OpenAI-compatible API.
- Конфигурируемые параметры: `base_url`, `api_key`, `model`.
- Интеграция должна проектироваться как адаптер/порт, чтобы не связывать доменную логику с конкретным вендором.

## Архитектурные выводы из решений

- Нужен отдельный домен identity/access с жесткой одно-ролевой моделью на аккаунт.
- Нужен отдельный домен profiles, чтобы не смешивать auth/session concerns и role-specific user data.
- Нужен отдельный домен guardianship для связи parent ↔ student.
- Нужен единый верхний bounded context `courses`, внутри которого разделяются authoring, publication, access и catalog queries.
- Нужен отдельный lesson runtime engine, который исполняет граф урока.
- Нужен отдельный evaluation adapter для LLM-проверки свободных ответов.
- Нужен отдельный gamification domain, чтобы XP, hearts, badges и levels не были размазаны по lesson runtime.

## Источники и ориентиры

- Официальные рекомендации Go по структуре модулей и использованию `internal`: https://go.dev/doc/modules/layout
- Официальные рекомендации Go по именованию пакетов: https://go.dev/blog/package-names
- Effective Go по интерфейсам и общим idioms: https://go.dev/doc/effective_go
- Официальные рекомендации Go по `context.Context`: https://go.dev/blog/context
- Официальные рекомендации Go по отмене операций БД через `Context`: https://go.dev/doc/database/cancel-operations
- Официальные рекомендации Go по ошибкам: https://go.dev/blog/errors-are-values
- Официальные рекомендации Go по subtests: https://go.dev/blog/subtests
- Официальные рекомендации Go по table-driven tests: https://go.dev/wiki/TableDrivenTests
- Официальные рекомендации Go по fuzzing: https://go.dev/doc/security/fuzz/
- Stripe docs: Products and prices: https://docs.stripe.com/products-prices/overview
- Stripe docs: PaymentIntents lifecycle: https://docs.stripe.com/payments/paymentintents/lifecycle
- Stripe docs: Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Stripe docs: Entitlements: https://docs.stripe.com/billing/entitlements
- Локальный ориентир по hexagonal/DDD/clean: [hexagonal-ddd-clean-architecture.md](/Users/aatamplon/PycharmProjects/ai-rules/hexagonal-ddd-clean-architecture.md)

## Дополнительные архитектурные решения MVP

### 13. Каталог и доступ ученика к курсам

- Ученик видит единый экран курсов, но в данных курсы делятся на:
  - платформенные опубликованные курсы;
  - курсы, к которым ученик получил доступ по ссылке учителя.
- UI может показывать это как один список с секциями, без разделения на разные приложения и разные модели доступа.
- Платформенные курсы не требуют персонального access grant на каждого ученика. Их видимость выводится из факта публикации в платформенном каталоге.
- Отдельная сущность доступа к курсу нужна только для teacher/private access и других явных пользовательских разрешений.

### 14. Soft delete

- Для курсов, черновиков, ссылок-доступов и медиаресурсов используем soft delete.
- Для опубликованных ревизий soft delete не используем. Они append-only и нужны для аудита, воспроизводимости progress и совместимости с историческими данными.
- Для прогресса, попыток и игровых начислений удаление не допускается, только архивирование или скрытие из UI.
- Это нужно для аудита, восстановления и безопасной эволюции продукта.

### 15. Версионность курсов

- Версионность нужна уже в MVP.
- Любое прохождение ученика всегда привязано к конкретной опубликованной ревизии курса.
- Черновик учителя или админа может меняться, но это не должно ломать уже начатое прохождение.
- Опубликованная ревизия неизменяема.
- Access grant выдается на курс, а не на конкретную ревизию.
- При первом старте курса система создает `course_progress`, привязанный к текущей опубликованной ревизии.
- Если после этого публикуется новая ревизия, ученик продолжает незавершенное прохождение на той ревизии, на которой оно было начато.
- Новое прохождение или повторное прохождение после явного reset может использовать уже новую опубликованную ревизию.
- Черновик должен иметь optimistic locking версию, чтобы autosave и параллельное редактирование не затирали друг друга.

### 16. Уровни оценки свободного ответа

- Для MVP фиксируем уровни: `incorrect`, `partial`, `correct`.
- Эти значения используются в runtime, progress, gamification и UI.

### 17. Flow parent ↔ child

- В MVP родитель не создает child account вручную.
- Поддерживаемый flow: parent создает invite, ребенок входит через собственный SSO и подтверждает связь по token/deep link.
- User stories и UI должны трактоваться именно в этом варианте.

### 18. Teacher learner mode

- При одно-ролевой модели teacher не становится полноценным `student`.
- Формулировка "переключение на ученический вид" трактуется как preview/public-player mode без student progress, hearts и learner ACL.

### 19. Teacher onboarding gate

- Teacher считается onboarding-complete только после заполнения профиля с непустыми `display_name` и `organization_name`.
- До этого `GET /session` должен сигнализировать `teacher_profile_required = true`.
- Teacher authoring endpoints до завершения teacher onboarding должны возвращать доменный conflict, а UI обязан отправлять пользователя на экран `T-0`.

### 20. Синхронизация продуктовых документов

- `USER_STORIES.md`, `UI_PLAN.md` и `REQUIREMENTS.md` синхронизируются с этой архитектурой по критичным точкам:
  - teacher course moderation обязательна до доступа учеников;
  - parent-child flow реализуется через invite + child SSO claim;
  - feedback для free-text имеет три состояния (`correct`, `partial`, `incorrect`) и отдельный LLM-error retry state.
  - monetization применяется только к platform-owned content и выдается через admin-confirmed entitlement flow.
- Для backend/frontend контрактов источником истины считаются `ARCHITECTURE.md`, `DB_SCHEMA.md` и последующие детальные спецификации API.

### 21. Monetization Scope

- На старте платным может быть только платформенный контент (`owner_kind = platform`).
- Teacher-owned content по умолчанию и по правилам продукта всегда бесплатный.
- Учитель не может создавать offer, цену или платный доступ для своего курса.
- Архитектура должна поддерживать monetization targets как минимум для `lesson`, с возможностью позже добавить `course` без перелома модели.
- Инвариант platform-only monetization должен проверяться и на domain service уровне, и на persistence уровне.

### 22. Payment Flow на старте

- Эквайринг в MVP не подключается.
- Оплата происходит вне платформы напрямую администратору.
- После внешней оплаты администратор фиксирует оплату в админке и система выдает доступ через стандартный entitlement flow.
- Даже в manual mode доступ не должен выдаваться через ad hoc ACL-изменение. Доступ выдается только через commerce-сущности `order/payment/entitlement`.
- Чтобы student-side flow не был тупиком, у платного offer в MVP есть lightweight purchase request flow: ученик оставляет заявку, а админ видит её в commerce backoffice и оформляет заказ вручную.

### 23. Разделение Commerce и Access

- Payment state и content access state не смешиваются.
- Оплата сама по себе не открывает контент напрямую.
- Доступ к платному контенту определяется только активным entitlement.
- Teacher/private course access остается отдельным механизмом через `course_access_grants` и не зависит от commerce.

### 24. Fulfillment Policy

- После подтвержденной оплаты entitlement выдается отдельным fulfillment use case.
- Fulfillment обязан быть идемпотентным, потому что повторное admin-confirm действие или сетевой retry не должны порождать duplicate payment/effective access.
- Если entitlement revoked во время активной paid session, use case revoke должен переводить соответствующие `lesson_sessions.status` в `terminated` в рамках той же доменной операции, а не оставлять это только на lazy runtime check.

### 25. Price Snapshot Policy

- Исторические продажи не должны зависеть от текущей цены в каталоге.
- Цена, валюта и название продаваемого offer snapshot-ятся в order/payment record в момент продажи.
- Для MVP этого достаточно; отдельные price revisions не являются обязательной сущностью.

### 26. Minimal Commerce Scope

- В MVP не вводим отдельный webhook inbox и provider event table.
- В MVP не вводим target replacement table для исторически проданного контента.
- Если платный lesson уже продавался, его удаление из публикуемой модели должно быть запрещено до появления отдельной migration policy.
- Future acquiring остается архитектурным extension point, а не обязательной частью MVP-схемы.

### 27. Stable Monetization Target IDs

- Если lesson продается отдельно, его `lesson_id` должен быть логически стабильным в рамках `course_id` между ревизиями.
- Commerce ссылается на logical target (`course_id + lesson_id`), а не на конкретную published revision.
- Published revision snapshot обязан фиксировать monetization policy для lesson nodes, чтобы уже начатое прохождение не меняло правила доступа ретроактивно.
- Для MVP не проектируем target replacement policy.
- Если paid lesson уже продавался, его нельзя удалять, переиспользовать под другой контент или менять его logical target identity.

### 28. Purchase Request and Order Resolution Policy

- Student может создать purchase request только для active platform offer.
- На один `student + offer` может существовать только одна open request.
- Создание manual order по request должно в той же transaction помечать request как `processed`.
- Complimentary grant на тот же target должен в той же transaction:
  - отменять open/pending order для этого `student + target`, если он еще не оплачен;
  - помечать соответствующие open purchase requests как `processed`;
  - затем выдавать entitlement.
- Если по target уже есть `fulfilled` order, complimentary grant не должен пытаться создавать второе активное entitlement и должен завершаться deterministic no-op или явным conflict по policy.

### 29. Archived Offer Policy

- Новый purchase request и новый manual order допустимы только для `commercial_offers.status = active`.
- Если offer был архивирован после создания order, existing order все равно может быть подтвержден и fulfilled по уже сохраненному snapshot.
- Архивация offer останавливает новые продажи, но не ломает уже созданные order records.

## Цели архитектуры MVP

- Сохранить backend как один деплоимый процесс без микросервисного оверхеда.
- Разделить систему на доменные модули с явными границами владения данными и правилами доступа.
- Исключить связность через общие таблицы, общие DTO и generic-пакеты `utils`, `service`, `repository`, `model`.
- Сделать бизнес-логику тестируемой без HTTP, без реального SSO и без реального LLM.
- Поддержать быстрые продуктовые изменения в ролях, правилах публикации, механике доступа и логике геймификации.
- Уложить backend-модель в UI из [UI_PLAN.md](/Users/aatamplon/PycharmProjects/hse/pravoprost/UI_PLAN.md), чтобы frontend не изобретал свою доменную модель поверх API.

## Архитектурный стиль

- Backend: модульный монолит.
- Стиль границ: package-oriented design + ports and adapters на уровне модулей, а не религиозная многослойность в каждом файле.
- Transport: HTTP JSON API.
- Persistence: PostgreSQL как основной transactional storage.
- File storage: S3-compatible object storage для иллюстраций и аватаров.
- Auth: SSO + серверная cookie-session.
- Frontend: React SPA с role-based route shells.

### Почему модульный монолит

- Для MVP важны быстрые изменения продуктовой логики, а не независимый runtime отдельных сервисов.
- Домены плотно связаны транзакционно: прохождение урока, прогресс, hearts и XP лучше согласовывать внутри одного процесса.
- Главный риск здесь не масштабирование по сервисам, а деградация структуры кода. Поэтому основной фокус архитектуры должен быть на package boundaries, тестируемости и ownership.

## Правила качества Go-кода для этого монолита

- Пакеты называются по предметной области, а не по техническому шаблону.
- Нельзя заводить пакеты `common`, `utils`, `helpers`, `base`, `service`, `repository`, `models`.
- Каждый доменный модуль владеет своими сущностями, своими use cases и своими репозиториями.
- Межмодульное взаимодействие идет только через явно импортируемые публичные API модуля или через узкие consumer-defined interfaces.
- HTTP DTO не должны протекать в доменный код.
- SQL-модели и storage-представления не должны быть доменной моделью.
- Все use cases принимают `context.Context` первым аргументом.
- Ошибки возвращаются как значения с контекстом и матчингом через `errors.Is` и `errors.As`.
- Каждая внешняя интеграция должна иметь фейковую реализацию для unit-тестов.
- Внутри use case должен быть ровно один явный orchestration flow, без скрытой магии в middleware и без неявных сайд-эффектов.

## Import Policy

- Для каждого доменного модуля публичным считается только root package модуля.
- Внутренние подпакеты вида `http/`, `postgres/`, `openai/`, `s3/` не импортируются другими доменными модулями.
- Межмодульные зависимости идут только через root package types, interfaces и explicit query DTO.
- `platform/dbtx` предоставляет только технические примитивы транзакции и не содержит бизнес-оркестрации.
- Нарушения import policy должны проверяться в CI отдельным architecture check script.

## Что запрещено архитектурно

- Прямой доступ одного модуля к таблицам другого модуля.
- Импорт `postgres`-адаптера одного модуля из другого модуля.
- Shared "god package" с доменными типами для всех модулей.
- Глобальные транзакционные сервисы, которые знают всё о системе.
- Попытка строить generic framework внутри приложения.
- Преждевременное дробление на десятки пакетов `app/domain/ports/usecase` там, где достаточно одного ясного package boundary.

## Системная топология MVP

```text
Browser (React SPA)
        |
        v
Go HTTP API + Session/Auth Middleware
        |
        +--> Identity
        +--> Profiles
        +--> Guardianship
        +--> Courses
        +--> Commerce
        +--> Lesson Runtime
        +--> Progress
        +--> Gamification
        +--> Assets
        +--> LLM Evaluation Adapter
        |
        +--> PostgreSQL
        +--> S3-compatible object storage
        +--> OpenAI-compatible API
```

## Границы backend-модулей

### 1. Identity

Ответственность:
- вход через SSO;
- создание аккаунта при первом логине;
- хранение роли;
- серверные сессии;
- выдача `CurrentUser`.

Владеет:
- account;
- external identity;
- session;
- role assignment.

Не владеет:
- profile data;
- связями parent ↔ student;
- прогрессом;
- курсами.

### 2. Profiles

Ответственность:
- role-specific profile data;
- display name;
- avatar binding;
- teacher organization metadata;
- profile read/update endpoints.

Владеет:
- student profile;
- parent profile;
- teacher profile;
- admin profile.

### 3. Guardianship

Ответственность:
- связь parent ↔ student;
- инвайты и подтверждение связи;
- ограничения "не более двух родителей на одного ребенка";
- чтение списка детей родителя и списка родителей ребенка.
- flow вида "родитель создает инвайт, ребенок после собственного SSO-входа подтверждает привязку".

Владеет:
- guardian link;
- guardian link invite/request.

Не владеет:
- профилем пользователя;
- прогрессом;
- правами доступа к курсам.

### 4. Courses

`courses` является единым bounded context и владельцем `course_id`.

Внутри него разделяются четыре логических subdomain:
- `authoring`
- `publication`
- `access`
- `catalogqueries`

#### 4a. Courses / Authoring

Ответственность:
- создание и редактирование черновика курса;
- редактирование структуры модулей и уроков;
- редактирование lesson graph;
- валидация черновика;
- отправка на модерацию.
- orchestration preview use case поверх draft snapshot.

Владеет:
- course draft;
- draft content document;
- authoring validation result.

Не владеет:
- опубликованным каталогом;
- прогрессом учеников;
- выдачей постоянного доступа по ссылке.

#### 4b. Courses / Publication

Ответственность:
- очередь модерации teacher courses;
- принятие решения approve/reject;
- публикация immutable course revision;
- хранение review history;
- переключение текущей опубликованной версии курса.
- отдельный publish flow для platform-owned courses.

Владеет:
- review decision;
- published course revision;
- publication lifecycle.

#### 4c. Courses / Access

Ответственность:
- получение учеником доступа к курсу по ссылке;
- жизненный цикл access links;
- определение, какая published revision должна открываться ученику при старте или продолжении курса.

Владеет:
- course access grant для teacher/private courses;
- course access token/link.

#### 4d. Courses / Catalog Queries

Ответственность:
- выдача списка доступных курсов;
- объединение платформенных и teacher-курсов в единый catalog view;
- read models для course tree и catalog cards.

Владеет:
- catalog projections.

### 5. Commerce

`commerce` является отдельным bounded context для monetization платформенного контента.

Внутри него разделяются четыре логических subdomain:
- `offers`
- `orders`
- `payments`
- `entitlements`

#### 5a. Commerce / Offers

Ответственность:
- описание sellable offer для платформенного контента;
- хранение текущей цены offer;
- привязка offer к monetization target;
- правила видимости offer в student UI;
- запрет monetization для teacher-owned content.
- enforcement того, что offer target резолвится только в `owner_kind = platform`.
- snapshot price/title/target в момент создания order.

Владеет:
- commercial offer;
- offer target metadata.

#### 5b. Commerce / Orders

Ответственность:
- создание order на покупку или ручное оформление продажи;
- обработка student purchase requests;
- snapshot offer title, amount, currency и target в order;
- lifecycle order до fulfillment.

Владеет:
- commercial order.
- purchase request.

#### 5c. Commerce / Payments

Ответственность:
- учет платежных записей;
- manual payment confirmation со стороны админа;
- anti-duplication и idempotency на платежном уровне.
- reconciliation amount/currency перед fulfillment.

Владеет:
- payment record;
- external payment reference.

#### 5d. Commerce / Entitlements

Ответственность:
- выдача доступа к платному контенту после подтвержденной оплаты;
- ручные admin grants и complimentary grants;
- revoke policy;
- единая проверка entitlement для платного контента.
- invalidation active sessions после revoke по policy.

Владеет:
- entitlement grant;
- fulfillment history.

### 6. Lesson Runtime

Ответственность:
- запуск урока;
- перемещение по DAG-графу шагов;
- прием ответа ученика;
- выбор evaluator в зависимости от типа шага;
- вычисление перехода по графу;
- формирование immediate feedback;
- завершение lesson session.

Владеет:
- lesson session;
- step attempt;
- runtime state machine.
- application use case `SubmitAnswer`.

Не владеет:
- хранением черновиков;
- правилами модерации;
- итоговым игровым балансом ученика.

### 6a. Lesson Engine

Ответственность:
- чистое исполнение lesson graph поверх абстрактного lesson document;
- навигация по узлам;
- применение verdict к переходам;
- единый player contract для student runtime и preview.

Владеет:
- graph traversal rules;
- node rendering contract;
- transition resolution.

Не владеет:
- реальными student sessions;
- progress;
- persistence.

### 7. Progress

Ответственность:
- прогресс по курсу;
- прогресс по урокам;
- статистика для ученика, родителя, учителя, админа;
- read models для профиля и таблиц успеваемости.

Владеет:
- course progress;
- lesson progress;
- progress projections и агрегированной attempt history для отчетности;
- aggregated stats.

### 8. Gamification

Ответственность:
- XP;
- hearts;
- streak;
- levels;
- badges;
- правила начисления и списания;
- восстановление hearts по времени.

Владеет:
- student game state;
- game event ledger;
- badge awards;
- streak state;
- level rules.

### 9. Assets

Ответственность:
- загрузка изображений;
- хранение metadata;
- выдача URL;
- привязка иллюстраций к шагам урока и курсам.

### 10. Evaluation

Ответственность:
- унифицированный интерфейс оценки ответа;
- локальная оценка single choice;
- LLM-оценка free text;
- парсинг структурированного ответа модели;
- timeouts, retries, fallback errors.

Владеет:
- evaluation contracts;
- llm adapter;
- prompt templates.

## Межмодульные правила взаимодействия

- `identity` не знает ничего про курсы и прогресс.
- `profiles` не знает ничего про guardianship и courses.
- `guardianship` использует только публичный read API `identity` и `profiles` для проверки ролей и отображаемых имен.
- `courses/authoring` не пишет в таблицы `progress`.
- `courses/authoring` preview использует общий `lessonengine`, а не отдельную логику прохождения.
- `commerce` не владеет course content и хранит только ссылки на monetization targets.
- `courses/catalogqueries` и `lessonruntime` используют read API `commerce/entitlements`, но не читают payment records напрямую.
- `courses/catalogqueries` использует pinned `course_revision_id` и monetization snapshot этой revision при построении paid/free states.
- `lessonruntime` читает только опубликованные ревизии, а не черновики.
- `lessonruntime` обязан проверять entitlement не только на `start`, но и на `session`, `next` и `answer` для платного контента.
- `lessonruntime` является владельцем orchestration use case `SubmitAnswer` и вызывает `progress` и `gamification` через узкие transactional ports внутри одной application transaction.
- `progress` не вычисляет правила DAG-переходов; оно принимает уже сформированные runtime events.
- `gamification` не читает lesson graph; оно реагирует на результат шага и завершение урока.
- `gamification` владеет экономикой XP/hearts/streak и пишет собственный event ledger.
- `commerce/payments` не выдает доступ напрямую; entitlement выдается только через `commerce/entitlements`.
- `admin/courses/{courseID}/access-grants` применим только к `teacher_private` content и не может использоваться для platform monetization.
- `evaluation` не знает ничего о маршрутах урока; оно только возвращает verdict и feedback.

## Рекомендуемая структура репозитория backend

```text
cmd/
  server/
    main.go

internal/
  bootstrap/
    app.go
    config.go
    wiring.go

  httpserver/
    router.go
    middleware.go
    errors.go
    session.go

  identity/
    account.go
    session.go
    service.go
    errors.go
    oauth.go
    http/
    postgres/

  profiles/
    profile.go
    service.go
    errors.go
    http/
    postgres/

  guardianship/
    link.go
    invite.go
    service.go
    errors.go
    http/
    postgres/

  courses/
    course.go
    service.go
    errors.go
    http/
    postgres/
    authoring/
      draft.go
      draft_version.go
      lesson_graph.go
      validate.go
      preview.go
    publication/
      revision.go
      moderation.go
    access/
      grant.go
      invite_link.go
    catalogqueries/
      catalog.go
      tree.go

  commerce/
    service.go
    errors.go
    http/
    postgres/
    offers/
      offer.go
      target.go
    orders/
      order.go
      purchase_request.go
    payments/
      payment.go
      manual.go
    entitlements/
      entitlement.go
      fulfillment.go

  lessonruntime/
    session.go
    evaluator.go
    navigator.go
    service.go
    errors.go
    http/
    postgres/

  lessonengine/
    document.go
    player_state.go
    navigator.go
    renderer.go
    transitions.go

  progress/
    progress.go
    lesson_progress.go
    projections.go
    service.go
    http/
    postgres/

  gamification/
    state.go
    events.go
    streak.go
    rules.go
    service.go
    postgres/

  evaluation/
    result.go
    free_text.go
    single_choice.go
    openai/

  assets/
    asset.go
    service.go
    http/
    postgres/
    s3/

  platform/
    clock/
    idgen/
    slogx/
    dbtx/
```

## Почему такая структура лучше, чем `internal/services` и `internal/repositories`

- Пакет отражает домен, а не шаблон.
- Внутри одного модуля можно держать domain + use case рядом, не разрывая контекст.
- Postgres и HTTP-адаптеры физически отделены от доменной логики.
- Модуль можно читать сверху вниз как bounded context, а не искать файлы по слоям по всей кодовой базе.

## Рекомендуемая модель данных

Ниже не финальная DDL, а целевая предметная схема.

### Identity

- `accounts`
  - `id`
  - `role` = `unselected | student | parent | teacher | admin`
  - `status`
  - `created_at`
- `external_identities`
  - `id`
  - `account_id`
  - `provider`
  - `provider_subject`
  - `email`
  - `raw_profile_json`
- `sessions`
  - `id`
  - `account_id`
  - `session_token_hash`
  - `csrf_secret`
  - `expires_at`
  - `created_at`
  - `last_seen_at`
  - `revoked_at`

### Profiles

- `student_profiles`
  - `account_id`
  - `display_name`
  - `avatar_asset_id`
- `parent_profiles`
  - `account_id`
  - `display_name`
  - `avatar_asset_id`
- `teacher_profiles`
  - `account_id`
  - `display_name`
  - `organization_name`
  - `avatar_asset_id`
- `admin_profiles`
  - `account_id`
  - `display_name`
  - `avatar_asset_id`

### Guardianship

- `guardian_links`
  - `id`
  - `parent_id`
  - `student_id`
  - `parent_slot`
  - `status`
  - `created_at`
  - `accepted_at`
  - unique key: `(parent_id, student_id)`
  - unique partial key: `(student_id, parent_slot)` where status is active
- `guardian_link_invites`
  - `id`
  - `created_by_parent_id`
  - `token_hash`
  - `claimed_by_student_id`
  - `expires_at`
  - `used_at`
  - `revoked_at`

### Courses

- `courses`
  - `id`
  - `owner_kind` = `platform | teacher`
  - `owner_account_id`
  - `course_kind` = `platform_catalog | teacher_private`
  - `status` = `active | archived`
  - `deleted_at`
- `course_drafts`
  - `id`
  - `course_id`
  - `workflow_status` = `editing | in_review | changes_requested | archived`
  - `draft_version`
  - `title`
  - `description`
  - `age_min`
  - `age_max`
  - `cover_asset_id`
  - `content_json`
  - `updated_at`
  - `last_submitted_at`
  - `last_rejected_at`
  - `last_published_revision_id`
- `course_revisions`
  - `id`
  - `course_id`
  - `version_no`
  - `title`
  - `description`
  - `age_min`
  - `age_max`
  - `cover_asset_id`
  - `content_json`
  - `published_at`
  - `created_from_draft_id`
  - `is_current`
  - `disabled_at`
  - `monetization_policy_json`
  - unique key: `(course_id, version_no)`
  - unique partial key: `(course_id)` where `is_current = true`
- `course_revision_lessons`
  - `id`
  - `course_revision_id`
  - `course_id`
  - `module_id`
  - `lesson_id`
  - `title`
  - `sort_order`
  - unique key: `(course_revision_id, lesson_id)`
- `course_reviews`
  - `id`
  - `course_draft_id`
  - `submitted_by_account_id`
  - `submitted_draft_version`
  - `status` = `pending | approved | rejected`
  - `reviewer_id`
  - `review_comment`
  - `submitted_at`
  - `resolved_at`
  - `created_at`
  - unique partial key: `(course_draft_id)` where `status = pending`

### Access

- `course_access_links`
  - `id`
  - `course_id`
  - `token_hash`
  - `status` = `active | expired | revoked`
  - `expires_at`
  - `created_by_account_id`
  - invariant: only for `teacher_private` course with current published revision
- `course_access_grants`
  - `id`
  - `course_id`
  - `student_id`
  - `source` = `teacher_link | admin_grant`
  - `granted_by_account_id`
  - `granted_at`
  - `archived_at`
  - `first_claimed_via_link_id`
  - unique partial key: `(course_id, student_id)` where `archived_at is null`

### Commerce

- `commercial_offers`
  - `id`
  - `owner_kind` = `platform`
  - `target_type` = `lesson | course`
  - `target_course_id`
  - `target_lesson_id`
  - `title`
  - `description`
  - `price_amount_minor`
  - `price_currency`
  - `status` = `draft | active | archived`
  - `created_by_account_id`
  - `created_at`
  - `updated_at`
  - `archived_at`
  - constraint: target must resolve only to `courses.owner_kind = platform`
  - for `target_type = lesson`, activation must validate against `course_revision_lessons` of the current published revision
  - persistence-level enforcement: DB trigger/check on write path
- `purchase_requests`
  - `id`
  - `student_id`
  - `offer_id`
  - `status` = `open | processed | declined`
  - `created_at`
  - `processed_at`
  - `processed_by_account_id`
- `commercial_orders`
  - `id`
  - `student_id`
  - `offer_id`
  - `purchase_request_id`
  - `status` = `awaiting_confirmation | fulfilled | canceled`
  - `target_type`
  - `target_course_id`
  - `target_lesson_id`
  - `offer_snapshot_json`
  - `price_snapshot_amount_minor`
  - `price_snapshot_currency`
  - `created_by_account_id`
  - `created_at`
  - `fulfilled_at`
- `payment_records`
  - `id`
  - `order_id`
  - `amount_minor`
  - `currency`
  - `idempotency_key`
  - `external_reference`
  - `confirmed_by_admin_id`
  - `override_reason`
  - `paid_at`
  - `created_at`
  - unique key: `(order_id, idempotency_key)`
  - unique key: `(external_reference)`
- `entitlements`
  - `id`
  - `student_id`
  - `target_type` = `lesson | course`
  - `target_course_id`
  - `target_lesson_id`
  - `source_type` = `purchase | complimentary`
  - `order_id`
  - `status` = `active | revoked`
  - `granted_by_account_id`
  - `granted_at`
  - `revoked_at`
  - check: `purchase` requires `order_id`, manual grants and complimentary access do not
  - unique partial index: `(student_id, target_course_id)` where `status = 'active' and target_type = 'course'`
  - unique partial index: `(student_id, target_course_id, target_lesson_id)` where `status = 'active' and target_type = 'lesson'`
- `entitlement_fulfillment_log`
  - `id`
  - `order_id`
  - `payment_record_id`
  - `entitlement_id`
  - `created_at`
  - unique key: `(order_id, payment_record_id)`

### Progress

- `course_progress`
  - `id`
  - `student_id`
  - `course_id`
  - `course_revision_id`
  - `started_at`
  - `completed_at`
  - `last_lesson_id`
  - `status`
  - `correct_answers`
  - `partial_answers`
  - `incorrect_answers`
- `lesson_progress`
  - `id`
  - `student_id`
  - `course_progress_id`
  - `course_revision_id`
  - `lesson_id`
  - `status` = `not_started | in_progress | completed`
  - `best_verdict`
  - `replay_count`
  - `attempts_count`
  - `started_at`
  - `completed_at`
- `lesson_sessions`
  - owner module: `lessonruntime`
- `lesson_sessions`
  - `id`
  - `student_id`
  - `course_progress_id`
  - `course_revision_id`
  - `lesson_id`
  - `status`
  - `current_node_id`
  - `state_version`
  - `started_at`
  - `completed_at`
  - `terminated_at`
  - `termination_reason`
- `step_attempts`
  - `id`
  - `lesson_session_id`
  - `node_id`
  - `attempt_no`
  - `client_idempotency_key`
  - `answer_json`
  - `verdict`
  - `feedback_text`
  - `created_at`
  - `evaluator_type`
  - `model_name`
  - `evaluator_latency_ms`
  - `evaluator_trace_id`

### Gamification

- `student_game_state`
  - `student_id`
  - `xp_total`
  - `level`
  - `hearts_current`
  - `hearts_max`
  - `hearts_updated_at`
- `student_streak_state`
  - `student_id`
  - `current_streak_days`
  - `best_streak_days`
  - `last_activity_date`
- `game_events`
  - `id`
  - `student_id`
  - `source_type`
  - `source_id`
  - `xp_delta`
  - `hearts_delta`
  - `streak_delta`
  - `created_at`
- `student_badges`
  - `id`
  - `student_id`
  - `badge_code`
  - `awarded_at`
  - `source_type`
  - `source_id`

### Assets

- `assets`
  - `id`
  - `owner_account_id`
  - `storage_key`
  - `mime_type`
  - `size_bytes`
  - `width`
  - `height`
  - `created_at`
  - `deleted_at`

## Почему lesson graph лучше хранить в `content_json`

- Lesson graph является документной структурой: узлы, ребра, контент-блоки и условия перехода.
- Для authoring и preview чаще нужен весь документ целиком, а не отдельные узлы по SQL.
- Immutable published revision естественно хранится как snapshot.
- При publish дополнительно извлекается только легковесный registry lessons (`course_revision_lessons`) для целостности lesson progress, tree queries и commerce target validation.
- Прогресс и аналитика при этом остаются реляционными.

### Ограничение такого подхода

- Проверки целостности графа переносятся из БД в application validation layer.
- Поэтому publish pipeline обязан иметь строгую валидацию и тесты.

## Структура `content_json`

Рекомендуемая схема published revision:

```json
{
  "modules": [
    {
      "id": "module_1",
      "title": "Мошенники",
      "lessons": [
        {
          "id": "lesson_1",
          "title": "Подозрительная ссылка",
          "graph": {
            "startNodeId": "n1",
            "nodes": [
              {
                "id": "n1",
                "kind": "story",
                "nextNodeId": "n2",
                "body": {
                  "text": "Тебе пришло сообщение...",
                  "assetId": "asset_1"
                }
              },
              {
                "id": "n2",
                "kind": "single_choice",
                "prompt": "Что ты сделаешь?",
                "options": [
                  {
                    "id": "a1",
                    "text": "Открою ссылку",
                    "result": "incorrect",
                    "feedback": "Это опасно",
                    "nextNodeId": "n3"
                  },
                  {
                    "id": "a2",
                    "text": "Покажу взрослому",
                    "result": "correct",
                    "feedback": "Это безопасный вариант",
                    "nextNodeId": "n4"
                  }
                ]
              },
              {
                "id": "n5",
                "kind": "free_text",
                "prompt": "Почему нельзя вводить пароль?",
                "rubric": {
                  "referenceAnswer": "Пароль нельзя сообщать посторонним",
                  "criteria": [
                    "упоминает безопасность аккаунта",
                    "упоминает посторонних людей"
                  ]
                },
                "transitions": [
                  { "onVerdict": "correct", "nextNodeId": "n6" },
                  { "onVerdict": "partial", "nextNodeId": "n7" },
                  { "onVerdict": "incorrect", "nextNodeId": "n8" }
                ]
              }
            ]
          }
        }
      ]
    }
  ]
}
```

## Правила валидации lesson graph при публикации

- существует ровно один `startNodeId`;
- все `node.id` уникальны внутри урока;
- каждый `nextNodeId` указывает на существующий узел;
- все узлы достижимы от `startNodeId`;
- циклы запрещены;
- для `story` задан `nextNodeId`, кроме terminal-story узлов;
- для `single_choice` каждый вариант содержит `result`, `feedback`, `nextNodeId`;
- для `free_text` заданы rubric и transitions для всех трех verdict;
- узлы финала явно помечены как terminal либо не имеют исходящих переходов;
- иллюстрации и asset references существуют;
- lesson не может быть опубликован при наличии validation errors.

## Runtime-модель урока

`lessonengine` исполняет lesson document как чистый graph runner.
`lessonruntime` добавляет к нему student session, persistence, progress и gamification.

### Типы шагов

- `story`
- `single_choice`
- `free_text`
- `end`

### Единая модель результата проверки

Независимо от типа вопроса runtime получает один контракт:

```go
type Verdict string

const (
    VerdictIncorrect Verdict = "incorrect"
    VerdictPartial   Verdict = "partial"
    VerdictCorrect   Verdict = "correct"
)

type EvaluationResult struct {
    Verdict  Verdict
    Feedback string
}
```

Это важно, потому что:

- single choice и free text проходят через единый runtime pipeline;
- переход по графу после ответа не зависит от конкретного evaluator;
- UI должен поддерживать три feedback state: `correct`, `partial`, `incorrect`;
- gamification получает единый input.

### Как работает прохождение урока

1. Ученик открывает курс и выбирает урок.
2. Если у ученика нет активного `course_progress` по этому курсу, система привязывает новое прохождение к текущей опубликованной ревизии курса.
3. Если активный `course_progress` уже есть, урок всегда открывается в рамках его `course_revision_id`, даже если у курса появилась более новая опубликованная ревизия.
4. Runtime создает `lesson_session`, привязанную к `course_progress` и published `course_revision`.
5. Runtime поднимает in-memory player state через `lessonengine`.
6. Backend выдает текущий узел.
7. Перед приемом ответа runtime проверяет актуальное состояние hearts. Если `hearts_current = 0` и policy не разрешает продолжение, ответ не принимается и клиент получает состояние `out_of_hearts`.
8. Для `story` клиент вызывает `next`, и runtime через `lessonengine` переходит по `nextNodeId`.
9. Для `single_choice` runtime локально вычисляет verdict и feedback.
10. Для `free_text` runtime вызывает `evaluation` adapter.
11. Runtime записывает `step_attempt`.
12. Runtime вызывает `gamification` для списания hearts, начисления XP и обновления streak.
13. Runtime через `lessonengine` определяет следующий узел.
14. Если достигнут terminal node, урок завершается и progress обновляется.

### Resume semantics

- Выход из урока через `X` или обновление страницы не удаляет `lesson_session`; сессия остается в состоянии `in_progress`.
- `POST /courses/{courseID}/lessons/{lessonID}/start` должен быть идемпотентным и возвращать активную lesson session, если она уже существует.
- `GET /courses/{courseID}/lessons/{lessonID}/session` возвращает активную lesson session и текущий шаг для восстановления UI после refresh/reopen.
- Новая lesson session создается только если активной нет или предыдущая завершена.

### Progress bar для DAG-урока

- Progress bar не вычисляется на frontend.
- Backend отдает готовое поле `progress_ratio`.
- Для MVP `progress_ratio` считается как `completed_counted_nodes / (completed_counted_nodes + shortest_remaining_path_nodes)`.
- На terminal node backend всегда возвращает `1.0`.
- Это дает монотонный и предсказуемый progress bar даже при ветвлении.

### Как работает preview черновика

1. Teacher или admin открывает preview.
2. `courses/authoring` берет текущий draft snapshot и прогоняет его через тот же validator, что и publish flow.
3. Если snapshot валиден, `courses/authoring` запускает `lessonengine` в preview mode.
4. Preview session живет отдельно от student progress и не пишет XP, hearts, badges и реальные attempts.
5. Таким образом UI player общий, а логика прохождения не дублируется.

## LLM-архитектура

### Порт оценки свободного ответа

Внутренний контракт:

```go
type FreeTextEvaluator interface {
    Evaluate(ctx context.Context, input FreeTextEvaluationInput) (EvaluationResult, error)
}
```

### Важные требования

- Адаптер к OpenAI-compatible API находится вне lesson runtime.
- Runtime не знает про `base_url`, `api_key`, `model`.
- Ответ модели должен парситься в строгий структурированный JSON-контракт.
- Нельзя принимать "вольный текст" модели как источник истины без парсинга.
- У интеграции обязателен timeout.
- При технической ошибке LLM урок не должен silently продолжаться; пользователь должен увидеть recoverable error и возможность повторить отправку.

### Что хранить по LLM-проверке

- verdict;
- feedback;
- provider trace/request id если доступен;
- model name;
- evaluator latency;
- исходный ответ ученика в БД;
- без логирования полного ответа и prompt в application logs.

## Commerce lifecycle

### Manual sale в MVP

1. Student оставляет purchase request на active platform offer.
2. Админ видит request в backoffice и создает `commercial_order` со snapshot цены и target.
3. Система в той же transaction помечает source `purchase_request` как `processed`.
4. После внешней оплаты админ подтверждает manual payment в админке, передавая `Idempotency-Key` и внешний reference.
5. `commerce/payments` сверяет `amount/currency` с order snapshot. При несовпадении fulfillment блокируется, либо требуется явный audit override.
6. `commerce/payments` создает `payment_record` строго идемпотентно.
7. `commerce/entitlements` запускает idempotent fulfillment.
8. Student получает entitlement на target lesson и видит lesson как доступный.

### Future payment integration point

- При подключении онлайн-оплаты новая интеграция должна вписываться в ту же модель `offer -> order -> payment_record -> entitlement`.
- В MVP не проектируем provider-specific API, webhook inbox и provider event persistence.

### State machine invariants

- `commercial_order.fulfilled` невозможен без выданного entitlement и записи в `entitlement_fulfillment_log`.
- `entitlement.status = active` невозможен для `commercial_order.status = canceled`.
- `complimentary` entitlement может существовать без order, но должен иметь `granted_by_account_id` и audit trail.
- complimentary grant по target с open/pending unpaid order должен атомарно cancel-ить этот order перед выдачей access.
- offer archival не инвалидирует уже созданный order snapshot.
- awaiting order uniqueness в MVP должна соблюдаться на уровне monetization target, а не только `offer_id`.

### Почему это правильно

- manual flow из MVP и будущая online payment integration должны сходиться в одну и ту же модель данных;
- access выдаётся одинаково независимо от способа оплаты;
- добавление эквайринга не ломает student ACL, catalog queries и lesson runtime.

## Геймификация

### XP

- XP начисляется за правильные и частично правильные ответы.
- Правила начисления лежат в `gamification/rules.go`, а не размазаны по handler и UI.

### Hearts

- Hearts живут в отдельном `student_game_state`.
- Восстановление hearts вычисляется лениво по `hearts_updated_at`, без cron в MVP.
- При каждом запросе состояния игра применяет "recovery algorithm", пересчитывает актуальный баланс и при необходимости сохраняет.
- Retry урока в MVP не является отдельным guaranteed hearts-recovery mechanic.

### Streak

- Streak хранится отдельно от XP/hearts правил, но внутри того же домена gamification.
- Для MVP streak обновляется по факту учебной активности за календарный день.
- UI получает уже рассчитанные поля `current_streak_days` и `best_streak_days`.

### Levels

- Level вычисляется из общего XP по детерминированной таблице правил.
- Таблица уровней хранится в коде как policy, а не в БД, пока продуктовые правила не стали действительно редакторскими.

### Badges

- Badge awarding оформляется как отдельная policy-функция, которая реагирует на доменные события:
  - первый завершенный урок;
  - первый завершенный курс;
  - N правильных ответов подряд;
  - и т.д.

## ACL и авторизация

### Student

- может видеть свои курсы и свой прогресс;
- может проходить опубликованные платформенные курсы;
- может видеть платные платформенные lesson offers, но не получает доступ к lesson без entitlement;
- может проходить teacher-курсы, если есть access grant;
- может подтверждать связь с родителем через invite token;
- не может видеть teacher analytics.

### Parent

- может видеть только привязанных детей;
- не может проходить уроки за ребенка;
- не может редактировать курс.

### Teacher

- может создавать и редактировать только свои курсы;
- может видеть прогресс только по своим опубликованным курсам;
- не может публиковать курс без модерации;
- может создавать access links только для уже опубликованного teacher-курса;
- не может видеть платформенные внутренние draft-курсы админов.

### Admin

- может создавать платформенные курсы;
- может модерировать teacher-курсы;
- может создавать offers и цены только для platform-owned content;
- может создавать manual paid orders, подтверждать manual payment и выдавать complimentary access;
- может управлять пользователями;
- имеет read access ко всей аналитике.

## Как UI ложится на backend

### Публичная часть

- `P-1 Лендинг` использует публичный read API для списка промо-курсов.
- Рекомендуемый контракт MVP: `GET /api/v1/public/promo-courses`.
- `P-2 SSO` работает через redirect endpoints backend.
- Для invite/link входа после SSO callback пользователь сначала проходит обязательный onboarding role (если первый вход), затем автоматически возвращается в `return_to` claim flow.

### Ученик

- `S-1 Выбор роли` маппится на onboarding use case `CompleteRoleSelection`.
- `S-3 Каталог` читает unified catalog view из `courses/catalogqueries`.
- `S-4 Дерево уроков` читает structure published revision + progress projection + entitlement/access state для каждого lesson node.
- `S-5 ... S-10` работают через `lessonruntime`, включая feedback state `correct | partial | incorrect`.
- `S-11 Жизни закончились` опирается на `student_game_state`.
- `S-12 Профиль` читает aggregated projection из `progress + gamification`.
- При технической ошибке LLM в `S-7` показывается recoverable error state с retry и повторным вызовом `POST /answer`.
- Для платных platform lessons student UI видит один из state:
  - `locked_paid`
  - `awaiting_payment_confirmation`
  - `granted`
- В MVP student UI не запускает встроенный checkout.

### Родитель

- `R-1 Кабинет родителя` читает `guardianship` + child summary projections.
- `R-2 Прогресс ребенка` использует read model из `progress`.
- Подтверждение parent link со стороны ребенка реализуется как student-side deep-link/token flow после SSO, даже если отдельный экран пока не вынесен в UI plan.
- Flow `Добавить ребенка` опирается на invite, который затем подтверждается ребенком после собственного SSO-входа.

### Учитель

- `T-1 Кабинет учителя` читает список собственных курсов и их moderation status.
- Формулировка UI "переключение на ученический вид" трактуется как preview/public-player mode, а не как смена роли teacher на student.
- `T-2/T-3 Конструктор` редактирует `course_draft.content_json`.
- `T-4 Прогресс учеников` использует teacher-scoped progress read model.
- `T-5 Предпросмотр` использует тот же player UI, но backend работает в preview mode и не пишет реальный progress.
- Кнопка "Поделиться ссылкой" активна только для опубликованного teacher course; до публикации teacher видит moderation status и не может выдать рабочую ссылку ученикам.

### Админ

- `A-1/A-2` используют те же authoring endpoints, но для платформенных курсов.
- Админ получает отдельные moderation endpoints, direct publish flow для platform-owned courses и user management endpoints.
- Для коммерческой модели админ получает отдельный backoffice flow: создать offer, назначить цену, зарегистрировать manual payment, выдать entitlement конкретному student.

## API-срезы MVP

### Auth / Session

- `GET /api/v1/session`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/sso/{provider}/start`
- `GET /api/v1/auth/sso/{provider}/callback`
- `POST /api/v1/onboarding/role`

Для link-based flows:

- `GET /api/v1/auth/sso/{provider}/start` принимает `return_to`.
- Backend сохраняет `return_to` в pre-auth state (server session), чтобы после callback вернуть пользователя к claim flow (`guardian-link` или `course-link`).

Для `POST /onboarding/role`:

- роль можно установить только один раз;
- повторный запрос с той же ролью идемпотентен;
- повторный запрос с другой ролью возвращает ошибку конфликта.

### Student

- `GET /api/v1/student/catalog`
- `GET /api/v1/student/courses/{courseID}`
- `GET /api/v1/student/game-state`
- `POST /api/v1/student/guardian-links/claim`
- `POST /api/v1/student/course-links/claim`
- `POST /api/v1/student/offers/{offerID}/purchase-requests`
- `POST /api/v1/student/courses/{courseID}/lessons/{lessonID}/start`
- `GET /api/v1/student/courses/{courseID}/lessons/{lessonID}/session`
- `GET /api/v1/student/lesson-sessions/{sessionID}`
- `POST /api/v1/student/lesson-sessions/{sessionID}/next`
- `POST /api/v1/student/lesson-sessions/{sessionID}/answer`
- `POST /api/v1/student/courses/{courseID}/lessons/{lessonID}/retry`
- `GET /api/v1/student/profile`
- `PUT /api/v1/student/profile`

Для `POST /courses/{courseID}/lessons/{lessonID}/start`:

- backend применяет MVP prerequisite policy:
  - в рамках одного module lessons проходят последовательно по `sort_order`;
  - lesson открывается, если предыдущий lesson того же module уже завершен;
  - для первого lesson в module prerequisite не требуется;
- backend проверяет entitlement/access state до создания `lesson_session`;
- для platform paid lesson без entitlement возвращается доменная ошибка `content_locked_paid`;
- для `awaiting_confirmation` возвращается отдельное состояние с order metadata и support hint.

Для `POST /lesson-sessions/{sessionID}/answer`:

- клиент передает idempotency key;
- backend additionally проверяет `lesson_sessions.state_version`;
- попытка ответа при `hearts = 0` отклоняется до evaluation.
- backend повторно проверяет entitlement/access state, если lesson является платным.

Для `GET /courses/{courseID}/lessons/{lessonID}/session` и `POST /lesson-sessions/{sessionID}/next`:

- backend повторно проверяет entitlement/access state для платного lesson;
- revoked access должен останавливать дальнейшее продолжение session.

Для `GET /lesson-sessions/{sessionID}`:

- backend повторно проверяет entitlement/access state для платного lesson;
- revoked access должен останавливать доступ к уже открытой paid session.

### Parent

- `GET /api/v1/parent/children`
- `POST /api/v1/parent/children/link-invites`
- `GET /api/v1/parent/children/link-invites`
- `POST /api/v1/parent/children/link-invites/{inviteID}/revoke`
- `GET /api/v1/parent/children/{studentID}/progress`
- `GET /api/v1/parent/profile`
- `PUT /api/v1/parent/profile`

### Teacher

- `GET /api/v1/teacher/courses`
- `POST /api/v1/teacher/courses`
- `GET /api/v1/teacher/courses/{courseID}/draft`
- `PUT /api/v1/teacher/courses/{courseID}/draft`
- `POST /api/v1/teacher/courses/{courseID}/preview`
- `POST /api/v1/preview-sessions/{previewSessionID}/next`
- `POST /api/v1/preview-sessions/{previewSessionID}/answer`
- `POST /api/v1/teacher/courses/{courseID}/submit-review`
- `GET /api/v1/teacher/courses/{courseID}/review-status`
- `GET /api/v1/teacher/courses/{courseID}/access-links`
- `POST /api/v1/teacher/courses/{courseID}/access-links`
- `POST /api/v1/teacher/access-links/{linkID}/revoke`
- `GET /api/v1/teacher/courses/{courseID}/students`
- `GET /api/v1/teacher/courses/{courseID}/students/{studentID}`
- `POST /api/v1/teacher/courses/{courseID}/archive`
- `GET /api/v1/teacher/profile`
- `PUT /api/v1/teacher/profile`

Для `PUT /draft`:

- клиент передает `draft_version`;
- backend делает optimistic locking check;
- при конфликте возвращается явная ошибка версии, чтобы UI мог предложить reload/merge flow.

### Admin

- `GET /api/v1/admin/courses`
- `POST /api/v1/admin/courses`
- `GET /api/v1/admin/courses/{courseID}/draft`
- `PUT /api/v1/admin/courses/{courseID}/draft`
- `POST /api/v1/admin/courses/{courseID}/preview`
- admin preview использует тот же preview session contract, что и teacher preview
- `POST /api/v1/admin/courses/{courseID}/publish`
- `GET /api/v1/admin/moderation/queue`
- `POST /api/v1/admin/moderation/reviews/{reviewID}/approve`
- `POST /api/v1/admin/moderation/reviews/{reviewID}/reject`
- `POST /api/v1/admin/courses/{courseID}/access-grants`
- `GET /api/v1/admin/users`
- `GET /api/v1/admin/users/{userID}`
- `POST /api/v1/admin/users/{userID}/block`
- `POST /api/v1/admin/users/{userID}/unblock`
- `GET /api/v1/admin/profile`
- `PUT /api/v1/admin/profile`
- `GET /api/v1/admin/commerce/offers`
- `POST /api/v1/admin/commerce/offers`
- `PUT /api/v1/admin/commerce/offers/{offerID}`
- `GET /api/v1/admin/commerce/purchase-requests`
- `POST /api/v1/admin/commerce/purchase-requests/{requestID}/decline`
- `GET /api/v1/admin/commerce/orders`
- `POST /api/v1/admin/commerce/orders/manual`
- `POST /api/v1/admin/commerce/orders/{orderID}/payments/manual-confirm`
- `POST /api/v1/admin/commerce/entitlements/grants`
- `POST /api/v1/admin/commerce/entitlements/{entitlementID}/revoke`
- `POST /api/v1/assets/upload-requests`

Admin commerce flow для MVP:

- ученик может оставить purchase request на конкретный paid offer;
- админ видит purchase requests и может создать order вручную для конкретного student и конкретного offer;
- админ может отклонить purchase request, если продажа не будет обработана;
- после подтверждения внешней оплаты админ фиксирует manual payment record с `Idempotency-Key` и `external_reference`;
- before fulfillment система делает reconciliation по amount/currency against order snapshot;
- entitlement выдается fulfillment use case автоматически;
- complimentary access оформляется отдельным entitlement grant без fake payment record.
- complimentary access по тому же target должен cancel-ить unpaid pending order и закрывать open purchase requests;
- archived offer не принимает новые requests/orders, но уже созданный order может быть fulfilled по snapshot.
- `POST /admin/courses/{courseID}/access-grants` допустим только для `teacher_private` course и должен отклоняться для platform-owned content.

Для `POST /admin/commerce/orders/{orderID}/payments/manual-confirm`:

- `Idempotency-Key` обязателен;
- `external_reference` обязателен;
- `amount/currency` должны совпадать с order snapshot, если не указан explicit audited override;
- повторный submit не должен создавать второй succeeded payment record.

Assets flow для MVP:

- frontend запрашивает presigned upload request;
- загружает файл напрямую в object storage;
- затем использует возвращенный `asset_id` в profile/course draft content.

## Session и безопасность

- Используем server-side session cookie, а не JWT в localStorage.
- Предпочтительный deployment: same-origin frontend + backend, чтобы не тащить сложный CORS.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`.
- Для cookie-authenticated mutating endpoints требуется CSRF-защита.
- При блокировке пользователя все активные sessions должны инвалидироваться.
- Все SQL-запросы параметризованы.
- Все исходящие HTTP-вызовы к SSO и LLM имеют timeout.
- Логи не содержат токены, cookies и сырые детские ответы.
- `return_to` для link-based flows хранится в server session state, а не в открытом query после callback.
- Raw tokens для guardian/course claim не должны передаваться в API path; frontend получает token из deep link и передает его в POST body.
- SSO raw profile snapshot должен иметь retention/minimization policy.
- Free-text ответы детей не должны сопровождаться PII в prompt, а интеграция с внешним LLM требует отдельного privacy review до запуска.

## Frontend-архитектура на React

### Общий подход

- Один React-кодbase для MVP.
- Route groups и layout shells разделены по ролям.
- Общие визуальные primitives и player components переиспользуются между student, teacher preview и admin preview.
- Backend остается source of truth; frontend не дублирует доменную логику DAG, hearts и publication workflow.

### Рекомендуемая структура frontend

```text
src/
  app/
    router/
    providers/
    layouts/

  shared/
    ui/
    lib/
    api/

  features/
    auth/
    onboarding/
    catalog/
    course-tree/
    lesson-player/
    parent-children/
    progress-view/
    teacher-course-list/
    teacher-course-editor/
    teacher-course-preview/
    admin-moderation/
    admin-commerce/
    admin-users/

  entities/
    user/
    course/
    lesson/
    progress/
```

### State management

- Server state должен жить в query/cache слое, а не в самодельном global store.
- Draft editor должен иметь собственное локальное document state и явный autosave flow.
- Player state должен быть тонким и опираться на backend responses, а не самостоятельно считать правильность.

### Почему это хорошо ложится на UI_PLAN

- Student player и preview teacher/admin используют один и тот же lesson rendering pipeline.
- Каталог, дерево курса и профиль получают уже агрегированные backend DTO.
- Parent и teacher получают read models, пригодные для таблиц и dashboard UI без толстого client-side assembly.
- `entities/` на frontend должны содержать только API DTO и базовые селекторы, без дублирования бизнес-логики.

## Read models и projections

Чтобы не тащить на frontend сырую доменную модель, backend должен отдавать отдельные projection DTO:

- `StudentCatalogItem`
- `StudentCourseTree`
- `StudentLessonAccessState`
- `StudentProfileSummary`
- `ParentChildSummary`
- `ChildProgressSummary`
- `TeacherCourseCard`
- `TeacherCourseDraftView`
- `TeacherStudentProgressRow`
- `AdminModerationQueueItem`
- `AdminModerationCourseDetail`
- `AdminCommercialOfferView`
- `AdminCommercialOrderView`

Дополнительные правила:

- `StudentCatalogItem` для платформенных курсов строится из опубликованных platform revisions и не требует отдельной user-specific grant записи.
- `StudentCourseTree` всегда строится на основе active `course_progress.course_revision_id`, если прохождение уже начато.
- monetization state для lesson nodes берется из pinned revision snapshot, а не из текущего offer catalog безусловно.
- Teacher/private course может появиться в `StudentCatalogItem` только после явного claim access link или admin grant.
- Для platform paid content `StudentCourseTree` должен отдавать по каждому lesson node access state и offer metadata.

Минимальные frontend DTO-контракты:

- `StudentLessonAccessState`
  - `lesson_id`
  - `access_state` = `free | granted | locked_paid | awaiting_payment_confirmation | locked_prerequisite | locked_teacher_access`
  - `offer`
  - `order`
  - `support_hint`
  - `locked_prerequisite` в MVP означает незавершенный предыдущий lesson в том же module по `sort_order`
- `CommercialOfferView`
  - `offer_id`
  - `title`
  - `price_amount_minor`
  - `currency`
  - `target_type`
  - `target_lesson_id`
- `LessonStepView`
  - `session_id`
  - `state_version`
  - `node_id`
  - `node_kind`
  - `payload`
  - `steps_completed`
  - `steps_total`
  - `progress_ratio`
- `AnswerOutcome`
  - `verdict` = `correct | partial | incorrect`
  - `feedback_text`
  - `xp_delta`
  - `hearts_delta`
  - `game_state`
  - `next_action` = `show_next_node | lesson_completed | out_of_hearts | retry_llm`
  - `next_node_id`
  - `lesson_completion`
- `PreviewAnswerOutcome`
  - `verdict`
  - `feedback_text`
  - `next_step`
  - preview outcome intentionally does not contain XP/hearts/game state deltas
- `StudentGameStateView`
  - `xp_total`
  - `level`
  - `hearts_current`
  - `hearts_max`
  - `hearts_restore_at`
  - `hearts_restore_at` вычисляется backend из persisted `hearts_updated_at` и recovery policy

Это не отдельные сервисы и не CQRS-платформа. Это просто специализированные query handlers внутри монолита.

## Транзакционные границы

- Один HTTP use case = одна явная application transaction.
- Владельцем orchestration use case `SubmitAnswer` является `lessonruntime`.
- `SubmitAnswer` должен атомарно:
  - записать attempt;
  - обновить lesson session;
  - обновить course progress;
  - обновить game state.
- Если шаг зависит от LLM, внешний вызов лучше сделать до финальной DB transaction, а затем сохранить результат атомарно.
- Для защиты от повторной отправки ответа нужен idempotency key или optimistic check на `lesson_sessions.state_version`.
- `next` для не-question node должен быть duplicate-safe.
- Клиент передает `expected_node_id`; если `state_version` уже устарел, но runtime видит, что текущий state соответствует детерминированному результату перехода из этого `expected_node_id`, backend может вернуть уже текущий post-transition state вместо hard conflict.
- Autosave черновика должен использовать optimistic locking по `course_drafts.draft_version`.
- `platform/dbtx` используется только как технический unit-of-work primitive и не содержит бизнес-решений.

## Тестовая стратегия

### Backend

- Unit tests на доменную логику DAG, verdict routing, hearts recovery, badge awarding.
- Table-driven tests для правил валидации и policy-функций.
- Subtests для группировки сценариев по use case.
- Fuzz tests для graph validation и парсинга structured LLM output.
- Integration tests на postgres adapters.
- Contract tests на OpenAI-compatible adapter с fake server.

### Frontend

- Component tests на lesson player states.
- Integration tests на teacher editor document flow.
- E2E на критические сценарии:
  - student проходит урок;
  - student видит `locked_paid` lesson и не может его стартовать без entitlement;
  - student не может продолжить уже открытую paid lesson session после revoke;
  - admin не может создать commercial offer для teacher-owned target;
  - admin создает manual order, подтверждает внешнюю оплату и student получает доступ к paid lesson;
  - complimentary entitlement открывает lesson без payment record;
  - duplicate manual confirm не создает второй succeeded payment и не дублирует entitlement;
  - manual confirm с amount/currency mismatch не запускает fulfillment без explicit override;
  - archived offer не принимает новые requests/orders, но уже созданный order может быть fulfilled по snapshot;
  - complimentary grant закрывает unpaid pending order и открывает доступ без duplicate entitlement;
  - student перезагружает страницу в середине урока и корректно восстанавливает активную lesson session;
  - student получает `partial` verdict и UI рендерит отдельный feedback state;
  - student получает LLM timeout/error и повторно отправляет ответ через retry;
  - student подтверждает parent link после SSO;
  - student проходит flow `teacher link -> SSO -> onboarding role -> claim link` без потери token/return_to;
  - parent видит прогресс ребенка;
  - teacher не может выдать ссылку до публикации;
  - teacher отправляет курс на модерацию;
  - teacher получает reject comment, правит черновик и отправляет на повторную модерацию;
  - admin публикует курс;
  - teacher preview и student runtime дают одинаковую навигацию по одному графу;
  - student получает доступ по teacher link.

## План реализации MVP

### Этап 1. Foundation

- базовый Go server;
- config, logging, migrations;
- identity + SSO + session;
- profiles;
- роль при первом входе;
- базовый React shell.

### Этап 2. Student Core

- platform courses;
- published revision model;
- student catalog;
- tree view;
- lesson runtime без teacher authoring;
- progress;
- XP/hearts/levels/streak;
- idempotency и state-version checks для lesson runtime.

### Этап 2a. Commerce Foundations

- commerce catalog и offers для platform content;
- student purchase requests;
- manual commercial orders;
- manual payment confirm flow;
- entitlement fulfillment;
- lesson-level locked_paid states в student tree.

### Этап 3. Parent

- guardianship invite/link flow;
- student-side accept flow;
- parent dashboard;
- child progress read models.

### Этап 4. Teacher Authoring

- teacher cabinet;
- course draft editor;
- lesson graph editor;
- preview mode;
- optimistic draft autosave;
- access links для уже опубликованных teacher course.

### Этап 5. Moderation

- moderation queue;
- approve/reject flow;
- publication lifecycle;
- teacher progress dashboard.

### Этап 5a. Commerce Backoffice Hardening

- admin commerce screens;
- audit trail по orders/payments/entitlements;
- complimentary grants;
- clean future online-payment extension seam без включения checkout в MVP.

### Этап 6. Hardening

- badges;
- retry and timeout policies for LLM;
- auditability;
- performance tuning;
- security pass.

## Главные архитектурные риски и как их контролировать

- Риск: lesson graph станет невалидным документом.
  - Контроль: строгая validation pipeline + fuzz tests + preview uses published validator.
- Риск: monolith деградирует в shared-layer architecture.
  - Контроль: domain packages, ownership rules, import policy, CI architecture checks, запрет generic packages.
- Риск: teacher preview и student runtime разойдутся по логике.
  - Контроль: один runtime renderer и один backend graph executor.
- Риск: изменение опубликованного курса сломает прогресс.
  - Контроль: immutable published revisions.
- Риск: оплата и доступ будут смешаны в один state machine.
  - Контроль: отдельные contexts для orders/payments/entitlements и access checks только через entitlement.
- Риск: platform monetization можно будет обойти через teacher-style grants или слабые access guards.
  - Контроль: `teacher_private` grants only, entitlement checks на `start/session/next/answer`, platform-only offer invariant.
- Риск: LLM будет давать нестабильный формат.
  - Контроль: structured output contract, parser, retries, timeout, fallback error.
- Риск: гонки при повторной отправке ответа и autosave черновиков.
  - Контроль: idempotency keys, `state_version`, `draft_version`, optimistic locking.
- Риск: future checkout потребует ломать ручной flow.
  - Контроль: manual flow и future online-payment integration сходятся в единый order/payment/fulfillment pipeline.

## Итоговая рекомендация

- Строить MVP как модульный монолит на Go с PostgreSQL, S3-compatible storage и OpenAI-compatible adapter.
- Критическая архитектурная ось системы: `draft -> moderation -> immutable published revision -> runtime -> progress -> gamification`.
- Главная инвестиция в качество должна идти не в "чистые слои ради слоев", а в:
  - явные package boundaries;
  - immutable published revisions;
  - единый lesson runtime contract;
  - consumer-defined interfaces на внешних интеграциях;
  - качественные тесты на доменные policy и graph validation.
