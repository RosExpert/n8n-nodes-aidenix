# Security review & pre-publish fixes

> **Status:** проверка от 2026-05-27. Сборка ✅, 24/24 теста ✅, линтер ✅. Ниже — что надо поправить **до** `npm publish`.

---

## 🔴 Критичные правки

### 1. `baseUrl` по умолчанию указывает на localhost

**Файл:** `credentials/AidenixApi.credentials.ts:24`

```ts
default: 'http://localhost:8080',
```

**Проблема:** опубликованная community-нода у пользователя по умолчанию будет стучаться к его собственному localhost. В лучшем случае молча сломается, в худшем — попадёт на чужой сервис в его внутренней сети.

**Фикс:**
```ts
default: 'https://api.aidenix.com',
placeholder: 'https://api.aidenix.com',
```

И в `nodes/Aidenix/Aidenix.node.ts:158`:
```ts
const baseUrl = ((credentials.baseUrl as string) || 'https://api.aidenix.com').replace(/\/+$/, '');
```

---

### 2. Нет защиты от HTTP base URL → токен в plaintext

**Файл:** `nodes/Aidenix/Aidenix.node.ts` (метод `execute`)

**Проблема:** если пользователь пропишет `http://...` (не loopback), `X-API-Token` полетит **открытым текстом** по сети.

**Фикс — минимум (warn):**
```ts
if (
    baseUrl.startsWith('http://') &&
    !/^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(baseUrl)
) {
    this.logger.warn(
        `[Aidenix] Base URL "${baseUrl}" is not HTTPS — API token will be transmitted in cleartext.`,
    );
}
```

**Фикс — строго (recommended):**
```ts
const isLoopback = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(baseUrl);
if (baseUrl.startsWith('http://') && !isLoopback) {
    throw new NodeOperationError(
        this.getNode(),
        `Insecure Base URL: ${baseUrl}. Use HTTPS for non-loopback addresses.`,
    );
}
```

---

### 3. `uuid@9.0.1` — moderate CVE

**Адвизорий:** [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — отсутствует bounds-check в v3/v5/v6 при передаче `buf`. Мы `buf` не передаём → не эксплуатируется, но `npm audit` ругается, и инсталляторы будут видеть warning.

**Фикс — выкинуть зависимость (рекомендую):**

```ts
// nodes/Aidenix/Aidenix.node.ts
import { randomUUID, createHash } from 'node:crypto';

// Заменить uuidv4():
const idempotencyKey = randomUUID();

// Для deterministic-режима реализовать uuid v5 руками:
function uuidv5(name: string, namespace: string): string {
    const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(nsBytes).update(name).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;  // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80;  // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
```

Удалить `uuid` и `@types/uuid` из `package.json`. Плюс: одна prod-deps меньше → меньше attack surface.

**Альтернатива (минимум):** `npm install uuid@latest && npm install -D @types/uuid@latest` и проверить совместимость импортов.

---

### 4. Нет HTTP-таймаута на стороне клиента

**Файл:** `nodes/Aidenix/Aidenix.node.ts:212`

**Проблема:** `IHttpRequestOptions` не содержит `timeout` → используется дефолт n8n (часто 5 минут). Если бэк зависнет за прокси — workflow висит.

**Фикс:**
```ts
const requestOptions: IHttpRequestOptions = {
    method: 'POST',
    url: `${baseUrl}/api/search/business-fit/run`,
    headers: {
        'X-API-Token': apiToken,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': 'application/json',
        'X-Integration-Source': 'n8n',
    },
    body: { query },
    json: true,
    timeout: 120_000, // 90s бэк + 30s сеть/буфер
};
```

---

## 🟡 Желательно

### 5. `dist/tsconfig.tsbuildinfo` (61KB) в публикуемом tarball

Incremental-кеш TypeScript ездит в npm-пакет. Раздувает с ~28KB до ~92KB unpacked, а также раскрывает локальные пути сборки.

**Фикс — вынести вне `dist/`:**

`tsconfig.json`:
```jsonc
{
    "compilerOptions": {
        "incremental": true,
        "tsBuildInfoFile": "./.tsbuildinfo"
    }
}
```

И добавь в `.gitignore`:
```
.tsbuildinfo
```

**Альтернатива:** создать `.npmignore` с:
```
dist/tsconfig.tsbuildinfo
dist/**/*.js.map
```

Source-maps в публикуемом пакете — это и +6KB на пустом месте, и раскрытие исходных путей вида `C:\Users\User\Desktop\projects\...`. Для community-нода source-maps не нужны.

---

### 6. Валидация custom Idempotency Key

**Файл:** `nodes/Aidenix/Aidenix.node.ts:197`

**Проблема:** бэк проверяет длину `[1..255]`, но клиент пропустит что угодно. Newline в значении сломает HTTP-заголовок (header injection).

**Фикс:**
```ts
idempotencyKey = (options.idempotencyKey ?? '').trim();

if (!idempotencyKey) {
    throw new NodeOperationError(
        this.getNode(),
        'Idempotency Key is required when "Idempotency Key Strategy" is "Custom".',
        { itemIndex: i },
    );
}

if (idempotencyKey.length > 255) {
    throw new NodeOperationError(
        this.getNode(),
        `Idempotency Key is too long (max 255 chars, got ${idempotencyKey.length}).`,
        { itemIndex: i },
    );
}

if (/[\r\n\x00-\x1F]/.test(idempotencyKey)) {
    throw new NodeOperationError(
        this.getNode(),
        'Idempotency Key must not contain control characters.',
        { itemIndex: i },
    );
}
```

---

### 7. `NodeApiError` пробрасывает весь объект ошибки в UI

**Файл:** `nodes/Aidenix/Aidenix.node.ts:248`

**Проблема:** в текущем виде `error as JsonObject` уходит целиком в n8n UI и логи. Если бэк когда-нибудь добавит в error-body что-то чувствительное (headers, internal stacktrace, IP), это попадёт пользователю. Сейчас бэк безопасен, но это страховка на будущее.

**Фикс:**
```ts
throw new NodeApiError(this.getNode(), error as JsonObject, {
    message: 'Aidenix API request failed',
    description: (error as Error).message,
    itemIndex: i,
});
```

`description` явно ограничивает то, что покажет UI.

---

### 8. `idempotencyKey` в error-item при `continueOnFail`

**Файл:** `nodes/Aidenix/Aidenix.node.ts:239-243`

**Не блокер**, но: при `continueOnFail` ключ передаётся downstream-нодам в json. Это не секрет (UUID), но если downstream — публичный webhook или внешний сервис, ключ утечёт. Решение по вкусу — оставить или убрать.

---

## 🟢 Что уже хорошо

- ✅ `apiToken` помечен `typeOptions: { password: true }` — маскируется в UI
- ✅ `authenticate: IAuthenticateGeneric` — стандартный n8n-паттерн, токен идёт только в заголовке
- ✅ `.gitignore` корректный, `.env` исключён
- ✅ Никаких хардкод-токенов или dev-URL в коде/тестах
- ✅ Детерминированный idempotency-key через uuid-v5 — даёт retry-safety без дублирования AI-вызовов
- ✅ `RETRYABLE_STATUSES = {409, 504}` совпадает с контрактом бэка (402/422/451 не ретраятся)
- ✅ Тесты покрывают: happy path, retry, continueOnFail, все три стратегии idempotency, валидацию
- ✅ `pairedItem` проставлен → n8n корректно сшивает ветви данных
- ✅ Линтер `eslint-plugin-n8n-nodes-base/community` проходит чисто
- ✅ Tarball: 14 файлов, без `.ts` исходников, без `.env`

---

## ✅ Чеклист перед `npm publish`

### Код
- [ ] `baseUrl` default → `https://api.aidenix.com` (credentials + node)
- [ ] Warn или throw на HTTP base URL (не loopback)
- [ ] `uuid` заменён на `node:crypto` (или bump до `uuid@latest`)
- [ ] `timeout: 120_000` в `requestOptions`
- [ ] Валидация длины + control-chars в custom Idempotency Key
- [ ] `description` в `NodeApiError` (опционально)

### Сборка
- [ ] `tsBuildInfoFile` вынесен за `dist/`
- [ ] Source maps исключены из tarball (`.npmignore`)
- [ ] `npm run build` без ошибок
- [ ] `npm test` — 24/24 (+ новые тесты на валидацию)
- [ ] `npm run lint` без warnings
- [ ] `npm audit` — 0 vulnerabilities

### Публикация
- [ ] `npm pack --dry-run` — проверить содержимое tarball
- [ ] `CHANGELOG.md` обновлён под 0.1.0 (или сразу 0.2.0 с фиксами)
- [ ] `README.md` отражает актуальный default baseUrl
- [ ] `npm login` под аккаунтом организации Aidenix
- [ ] `npm publish --access public`
- [ ] `npm view n8n-nodes-aidenix` — пакет виден
- [ ] Установить в тестовый n8n-инстанс, прогнать workflow end-to-end

### Верификация в маркетплейсе n8n
- [ ] Issue в [n8n-io/n8n](https://github.com/n8n-io/n8n) с заголовком `Community node submission: n8n-nodes-aidenix`
- [ ] Указать: npm URL, README link, support email, демо-workflow

---

*Документ сформирован по результатам аудита билда + тестов + статического анализа кода 2026-05-27.*
