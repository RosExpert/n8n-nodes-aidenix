# n8n Community Node — следующие шаги после бэкенда

> **Адресат:** фронтенд/JS-разработчик  
> **Контекст:** бэкенд (FastAPI, ветка `n8n-integration`) готов. Теперь нужно создать npm-пакет с кастомным n8n-нодом, который будет доступен в маркетплейсе n8n.

---

## 1. Что уже готово на бэкенде

### Новый синхронный эндпоинт

```
POST /api/search/business-fit/run
```

**Auth:** заголовок `X-API-Token: <токен>`  
**Обязательный заголовок:** `Idempotency-Key: <uuid-v4>` (уникальный на каждый новый запрос, одинаковый при ретрае)

**Request body:**
```json
{ "query": "linkedin-slug-или-email" }
```

**Response (200) — плоская схема:**
```json
{
  "job_id": "uuid",
  "status": "completed",
  "query": "linkedin-slug-или-email",
  "fit_score_pct": 82,
  "person_description": "Александр — СТО финтех-стартапа...",
  "email_subject": "Быстрый вопрос",
  "email_message": "Привет, Александр...",
  "linkedin_message": "Добрый день, Александр...",
  "logic_explanation": ["Роль совпадает с ICP", "Компания в нужной стадии"],
  "strategy": "Практический подход",
  "strategy_do": ["Упомяни боль", "Будь конкретен"],
  "strategy_dont": ["Не начинай обобщённо"]
}
```

**Коды ответов:**
| Код | Ситуация |
|-----|----------|
| 200 | Успех |
| 409 | Запрос с этим ключом ещё обрабатывается → подожди 5 сек, ретрай |
| 422 | Тело запроса не совпадает с первым запросом по этому ключу |
| 451 | Контакт отказался от обработки данных |
| 402 | Квота исчерпана |
| 504 | Таймаут 90 сек — освободи ключ, можно ретрайнуть с тем же `Idempotency-Key` |

**Idempotency:** при повторном запросе с тем же `Idempotency-Key` сервер вернёт закешированный 200-ответ с заголовком `Idempotent-Replayed: true` — никаких повторных вычислений.

---

## 2. Что нужно создать: n8n Community Node

### Структура npm-пакета

```
n8n-nodes-aidenix/
├── package.json
├── tsconfig.json
├── .eslintrc.js
├── nodes/
│   └── Aidenix/
│       ├── Aidenix.node.ts       ← основной нод
│       └── aidenix.svg           ← иконка (SVG, ~40×40)
└── credentials/
    └── AidenixApi.credentials.ts ← форма для API-токена
```

### `package.json` — ключевые поля

```json
{
  "name": "n8n-nodes-aidenix",
  "version": "0.1.0",
  "description": "Aidenix Business Fit for n8n",
  "keywords": ["n8n-community-node-package"],
  "n8n": {
    "n8nNodesApiVersion": 1,
    "credentials": ["dist/credentials/AidenixApi.credentials.js"],
    "nodes": ["dist/nodes/Aidenix/Aidenix.node.js"]
  },
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc && gulp build:icons",
    "dev": "tsc --watch"
  }
}
```

> **Важно:** ключевое слово `n8n-community-node-package` — обязательно, именно по нему n8n находит пакет в реестре.

---

## 3. Реализация credentials

**`credentials/AidenixApi.credentials.ts`:**

```typescript
import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AidenixApi implements ICredentialType {
  name = 'aidenixApi';
  displayName = 'Aidenix API';
  documentationUrl = 'https://docs.aidenix.com';
  properties: INodeProperties[] = [
    {
      displayName: 'API Token',
      name: 'apiToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.aidenix.com',
    },
  ];
}
```

---

## 4. Реализация нода

**`nodes/Aidenix/Aidenix.node.ts` — скелет:**

```typescript
import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeApiError,
} from 'n8n-workflow';
import { v4 as uuidv4 } from 'uuid';

export class Aidenix implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Aidenix',
    name: 'aidenix',
    icon: 'file:aidenix.svg',
    group: ['transform'],
    version: 1,
    description: 'Evaluate business fit with Aidenix AI',
    defaults: { name: 'Aidenix Business Fit' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'aidenixApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Business Fit',
            value: 'businessFit',
            description: 'Evaluate business fit for a contact',
            action: 'Evaluate business fit for a contact',
          },
        ],
        default: 'businessFit',
      },
      {
        displayName: 'Query',
        name: 'query',
        type: 'string',
        default: '',
        required: true,
        description: 'LinkedIn slug or email of the contact',
        displayOptions: { show: { operation: ['businessFit'] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials('aidenixApi');
    const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const query = this.getNodeParameter('query', i) as string;
      const idempotencyKey = uuidv4(); // новый ключ на каждый item

      try {
        const response = await this.helpers.httpRequest({
          method: 'POST',
          url: `${baseUrl}/api/search/business-fit/run`,
          headers: {
            'X-API-Token': credentials.apiToken as string,
            'Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/json',
            'X-Integration-Source': 'n8n',
          },
          body: { query },
          returnFullResponse: false,
          // n8n автоматически ретраит при 409 если настроить retry-logic
        });

        results.push({ json: response });
      } catch (error) {
        if (this.continueOnFail()) {
          results.push({ json: { error: (error as Error).message, query }, pairedItem: i });
          continue;
        }
        throw new NodeApiError(this.getNode(), error as any);
      }
    }

    return [results];
  }
}
```

### Обработка 409 (in_progress) с ретраем

```typescript
// Хелпер для ретрая при 409
async function callWithRetry(
  fn: () => Promise<any>,
  maxRetries = 10,
  delayMs = 5000,
): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error?.response?.status === 409 && attempt < maxRetries) {
        await new Promise(res => setTimeout(res, delayMs));
        continue;
      }
      throw error;
    }
  }
}
```

---

## 5. Как n8n обрабатывает `Idempotency-Key`

Одно из ключевых решений: **один уникальный ключ на один контакт в рамках одного выполнения workflow**.

```
Workflow run #1:
  item[0] query="alex@example.com" → idempKey=uuid-A → 200 (computed)
  item[1] query="bob@example.com"  → idempKey=uuid-B → 200 (computed)

Workflow run #1 (ретрай после сбоя n8n):
  item[0] query="alex@example.com" → idempKey=uuid-A → 200 (replay, мгновенно!)
  item[1] query="bob@example.com"  → idempKey=uuid-B → 200 (replay, мгновенно!)
```

Для устойчивого ретрая лучше генерировать ключ детерминированно:
```typescript
// uuid v5 на основе (workflowId + executionId + itemIndex)
import { v5 as uuidv5 } from 'uuid';
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const key = uuidv5(`${workflowId}:${executionId}:${i}`, NAMESPACE);
```

---

## 6. Публикация

```bash
# 1. Зарегистрироваться на npmjs.com

# 2. Собрать пакет
npm run build

# 3. Опубликовать
npm publish --access public

# 4. Проверить что пакет виден
npm view n8n-nodes-aidenix
```

После публикации пакет доступен в n8n через **Settings → Community Nodes → Install → `n8n-nodes-aidenix`**.

---

## 7. Верификация в маркетплейсе n8n

Чтобы нод появился в официальном списке верифицированных нодов:

1. Опубликовать npm-пакет (п. 6 выше)
2. Открыть issue в репозитории [n8n-io/n8n](https://github.com/n8n-io/n8n) с заголовком `Community node submission: n8n-nodes-aidenix`
3. Заполнить форму: описание, npm URL, документация, контакт
4. Команда n8n проверяет качество кода, безопасность, документацию (~1-2 недели)
5. После апрува нод появляется в in-app каталоге

**Требования для верификации:**
- Пакет опубликован на npm с ключевым словом `n8n-community-node-package`
- Есть README с примерами использования
- Есть CHANGELOG
- Корректные типы TypeScript (без `any` там, где можно избежать)
- Обработка ошибок через `NodeApiError`
- Тесты (хотя бы базовые)

---

## 8. Чеклист для старта

- [ ] Создать репозиторий `n8n-nodes-aidenix` (отдельный от бэкенда)
- [ ] Инициализировать проект: `npx create-n8n-node@latest` или по шаблону [n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter)
- [ ] Реализовать `AidenixApi.credentials.ts`
- [ ] Реализовать `Aidenix.node.ts` с операцией `businessFit`
- [ ] Добавить SVG-иконку
- [ ] Написать README с workflow-примером
- [ ] Протестировать локально через `npm link` в n8n-инстансе
- [ ] Опубликовать на npm
- [ ] Подать заявку на верификацию

---

## 9. Полезные ссылки

| Ресурс | URL |
|--------|-----|
| Официальный гайд по community nodes | https://docs.n8n.io/integrations/creating-nodes/ |
| Стартер-шаблон | https://github.com/n8n-io/n8n-nodes-starter |
| Список верифицированных нодов | https://www.npmjs.com/search?q=keywords:n8n-community-node-package |
| Swagger бэкенда | `GET /docs` на нашем API-сервере |

---

*Документ подготовлен: 2026-05-25. Бэкенд: ветка `n8n-integration` в `aidenix-backend`.*
