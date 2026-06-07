<div align="center">
  <img src="src/assets/Scene 1.jpg" alt="Wisa Banner" width="100%" />

  # 🚀 Wisa

  ### *Your Peak SIWES Logbook Assistant*

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Built with grammY](https://img.shields.io/badge/Built%20with-grammY-blue.svg)](https://grammY.dev)
  [![Powered by AI](https://img.shields.io/badge/Powered%20by-OpenAI-green.svg)](https://openai.com)

  **Wisa** is a modern, AI-powered Telegram bot designed to help Nigerian students (SIWES/IT) manage their daily logbooks with ease. 

</div>

---

## Main Features

- **AI Log Refinement**: Send your rough daily activities and watch Wisa transform them into professional, IT-standard entries using AI.
- **Voice Log Support**: Too tired to type? Just send a voice note. Wisa transcribes, personalizes, and refines it instantly.
- **Catch-Up Mode**: Missed a few days? Wisa's catch-up helps you fill in the gaps without breaking a sweat.
- **Smart Reminders**: Customizable nudges and auto-snoozing to make sure you never miss a log entry.
- **Admin & User Dashboards**: Track your progress, manage subscriptions, and see detailed analytics.
- **Seamless Payments**: Professional storage and unlimited features unlocked via Paystack integration.

---

## 🛠️ Tech Stack

- **Framework**: [grammY](https://grammY.dev) (The most advanced Telegram Bot framework)
- **Database**: [Prisma](https://www.prisma.io/) with PostgreSQL
- **AI Engine**: [OpenAI GPT](https://openai.com/)
- **Server**: Express.js
- **Runtime**: Node.js (TypeScript)
- **deployment**: Railway & Nixpacks

---

## 🚀 Getting Started

### 1. Prerequisites

- **Node.js** (v20 or higher)
- **PostgreSQL** Database
- **Telegram Bot Token** (from [@BotFather](https://t.me/BotFather))
- **OpenAI API Key**

### 2. Environment Setup

Create a `.env` file in the root directory and add the following:

#### (Required)
```env
TELEGRAM_BOT_TOKEN=your_bot_token
DATABASE_URL="postgresql://user:password@localhost:5432/wisa"
JWT_SECRET=your_jwt_secret_for_dashboards
ADMIN_PASSWORD=your_admin_dashboard_password
```

#### AI Magic (Required for Refinement)
```env
OPENAI_API_KEY=your_openai_api_key
```

#### Revenue Flow (Optional - for Payments)
```env
PAYSTACK_SECRET_KEY=your_paystack_secret
PAYSTACK_WEBHOOK_SECRET=your_paystack_webhook_secret
```

#### 🌐 Others
```env
PORT=3000
DASHBOARD_ORIGIN=http://localhost:3000
```

### 3. Installation & Run

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

---

## Deployment

Wisa is production-ready and optimized for **Railway**.

1.  Create a new project on Railway.
2.  Connect your GitHub repository.
3.  Add the environment variables listed above.
4.  Railway will automatically detect the `railway.toml` and `nixpacks.toml` to build and deploy.

---

## Dashboards

- **User Dashboard**: Accessible via the link provided in the Telegram menu.
- **Admin Panel**: Navigate to `/admin` and authenticate using `ADMIN_PASSWORD`.

---

## License

Distributed under the MIT License. See `LICENSE` for more information.

---

<div align="center">
  Built with ❤️ for every student that wants to have the best IT experience.
</div>
