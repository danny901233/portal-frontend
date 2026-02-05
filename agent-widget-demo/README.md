# ReceptionMate AI Agent Widget

A standalone white-label widget for configuring voice AI agents. Designed to be embedded in customer websites via iframe.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

The widget will be available at `http://localhost:3001`

## 📦 Features

- **Dual Creation Modes**: Browse marketplace templates or create custom agents
- **Structured Configuration**: Greeting, tone, FAQs, knowledge base, tools, call flows
- **White-Label Ready**: ReceptionMate branding with customizable colors
- **Iframe Embeddable**: Works seamlessly in customer websites

## 🎨 Customization

### Brand Colors

Edit `tailwind.config.js` to customize the color scheme:

```javascript
colors: {
  receptionmate: {
    500: '#0ea5e9',  // Primary brand color
    600: '#0284c7',  // Hover states
    // ... other shades
  },
}
```

### Logo

Replace logo in `public/` directory and update references in components.

## 🔗 Embedding

### Basic Iframe

```html
<iframe 
  src="https://your-domain.com/widget" 
  title="ReceptionMate AI Agent Configurator"
  style="width: 100%; height: 800px; border: none;"
  allow="microphone"
></iframe>
```

### With Customer Context

```html
<iframe 
  src="https://your-domain.com/widget?customer=cust_123&garage=garage_abc"
  title="ReceptionMate AI Agent Configurator"
></iframe>
```

See `public/embed-example.html` for a complete demo.

## 🔐 Security

- Set `frame-ancestors` CSP header to whitelist allowed embedding domains
- Implement token-based authentication for customer-specific configs
- Use HTTPS in production

## 🏗️ Project Structure

```
agent-widget-demo/
├── app/
│   ├── page.tsx           # Main widget UI
│   ├── layout.tsx         # Root layout
│   └── globals.css        # Global styles
├── public/
│   └── embed-example.html # Iframe embedding demo
├── package.json
├── tailwind.config.js
└── next.config.ts
```

## 📝 Configuration Sections

The widget includes structured sections for:

1. **Basic Info**: Agent name
2. **Greeting**: Opening message for callers
3. **Tone & Personality**: Professional, friendly, empathetic, concise
4. **Knowledge Base**: FAQs and business information
5. **Tools**: (Coming soon) Calendar, booking, transfers
6. **Call Flows**: (Coming soon) Routing logic

## 🌐 Production Deployment

```bash
# Build for production
npm run build

# Start production server
npm start
```

## 📄 License

Internal use only - ReceptionMate proprietary software
