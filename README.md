# How to run

npm install
npm start

# Dev mode

npm install --save-dev nodemon

npm run dev

# Connect

curl -X POST http://localhost:3000/session -H "Content-Type: application/json" -d '{ "type": "odoo", "credentials": { "url": "https://localflow.odoo.com", "db": "localflow", "username": "xxx", "password": "xxx" } }'

curl -X POST http://localhost:3000/session -H "Content-Type: application/json" -d '{ "type": "salesforce", "credentials": { "loginUrl": "https://orgfarm-af32e100d8-dev-ed.develop.my.salesforce.com", "username": "xxx", "key": "xxx", "secret": "xxx" } }'

curl http://localhost:3000/metadata -H "Authorization: Bearer 1234567890"


# 🌐 Generic API Proxy for Business Objects (Salesforce & Odoo)

This is a simple Node.js API proxy that abstracts connections to backends like **Salesforce** and **Odoo** to expose CRUD operations and metadata access via a unified REST API.

---

## 📦 Features

- Plug-and-play connectors for **Salesforce** and **Odoo**
- Unified REST endpoints for:
  - ✅ Object metadata (`GET /metadata/:objectType`)
  - ✅ Read data (`GET /data/:objectType`)
  - ✅ Update (`PUT /data/:objectType/:id`)
  - ✅ Delete (`DELETE /data/:objectType/:id`)
  - ➕ Optional: Create (`POST /data/:objectType`)
- CORS-enabled for browser use

---

## 🏗️ Project Structure

```

api-proxy/
├── index.js
├── connectors/
│   ├── salesforce.js
│   └── odoo.js
├── .env
├── package.json
└── README.md

````

---

## ⚙️ Setup

### 1. Clone and Install

```bash
git clone https://github.com/your-org/api-proxy.git
cd api-proxy
npm install
````

### 2. Configure `.env`

Create a `.env` file:

```env
# Connector: choose 'salesforce' or 'odoo'
CONNECTOR=salesforce

# Salesforce credentials
SF_USERNAME=your-salesforce-username
SF_PASSWORD=your-password
SF_TOKEN=your-security-token
SF_LOGIN_URL=https://login.salesforce.com

# Odoo credentials
ODOO_URL=http://your-odoo-instance.com
ODOO_DB=your-database
ODOO_USERNAME=your-username
ODOO_PASSWORD=your-password
```

### 3. Start Server

```bash
npm start
```

API will be available at:
**`http://localhost:3000`**

---

## 🔗 API Endpoints

### 📘 Get Object Metadata

```http
GET /metadata/:objectType
```

#### Examples:

```bash
curl http://localhost:3000/metadata/Account           # Salesforce
curl http://localhost:3000/metadata/res.partner       # Odoo
```

---

### 📄 Get Records

```http
GET /data/:objectType
```

#### Examples:

```bash
curl http://localhost:3000/data/Account               # Salesforce
curl http://localhost:3000/data/res.partner           # Odoo
```

---

### ✏️ Update a Record

```http
PUT /data/:objectType/:id
Content-Type: application/json
```

#### Examples:

```bash
curl -X PUT http://localhost:3000/data/Account/001XXXXXXXXXXXXXXX \
  -H "Content-Type: application/json" \
  -d '{"Name": "Updated Account Name"}'

curl -X PUT http://localhost:3000/data/res.partner/5 \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Partner Name"}'
```

---

### ❌ Delete a Record

```http
DELETE /data/:objectType/:id
```

#### Examples:

```bash
curl -X DELETE http://localhost:3000/data/Account/001XXXXXXXXXXXXXXX
curl -X DELETE http://localhost:3000/data/res.partner/5
```

---

### ➕ (Optional) Create a Record

If you add `POST /data/:objectType`, you can create records.

```http
POST /data/:objectType
Content-Type: application/json
```

#### Examples:

```bash
curl -X POST http://localhost:3000/data/Account \
  -H "Content-Type: application/json" \
  -d '{"Name": "New Account"}'

curl -X POST http://localhost:3000/data/res.partner \
  -H "Content-Type: application/json" \
  -d '{"name": "New Partner"}'
```

---

## 🧩 Connector Selection

By default, connector is chosen from `.env`:

```env
CONNECTOR=salesforce
# or
CONNECTOR=odoo
```

> *You can extend this to support dynamic per-request connector routing if needed.*

---

## 🛠️ Todo / Ideas

* [ ] Add authentication middleware
* [ ] Add schema validation using metadata
* [ ] Support pagination and filtering
* [ ] Add connector for SAP or other CRMs/ERPs

---

## 📄 License

MIT

```

---

✅ You can now paste this entire block into your `README.md`. Let me know if you want a Markdown badge section, GitHub Actions CI status, or a Dockerfile!
```
