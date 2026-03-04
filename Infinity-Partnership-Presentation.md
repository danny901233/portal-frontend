# ReceptionMate x Infinity Partnership
## Voice AI Solution for Missed Calls & Out-of-Hours

---

## Meeting Agenda
- Solution Overview & Architecture
- Integration Model with Infinity Platform
- Use Case: Missed Calls & Out-of-Hours
- Technical Requirements & Security
- Commercial Model & Pilot Program
- Scaling Roadmap

---

## 1. Solution Overview

### What We Do
**ReceptionMate** provides AI-powered voice agents that handle phone calls autonomously:
- Natural conversation with customers
- Appointment booking & call routing
- Information capture & qualification
- CRM integration & data sync

### Technology Stack
- **LiveKit** - Real-time voice orchestration
- **Deepgram** - Speech-to-text (streaming)
- **OpenAI GPT-4 / Claude** - Conversational AI
- **ElevenLabs** - Natural voice synthesis
- **Twilio SIP** - Telephony connectivity

---

## 2. Integration Architecture

### Overflow/Failover Model (Option 2)

```
Customer Call Flow:
┌─────────────────────────────────────────────────────┐
│  1. Customer calls Infinity tracking number         │
│     (Infinity billable minutes start)                │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  2. Infinity routing logic:                          │
│     • Business hours + staff available → Phone       │
│     • No answer / Out of hours → AI Agent            │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  3. Bridged SIP forwarding to LiveKit               │
│     (Infinity remains in call path for recording)   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  4. ReceptionMate AI handles conversation           │
│     • Books appointments                             │
│     • Captures customer details                      │
│     • Provides information                           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  5. Call summary sent to:                           │
│     • Infinity platform (via API)                    │
│     • Customer's CRM                                 │
│     • ReceptionMate dashboard                        │
└─────────────────────────────────────────────────────┘
```

### Key Technical Requirement
**Bridged Call Forwarding (SIP re-INVITE)**
- Infinity maintains call leg to customer
- Forwards audio to ReceptionMate SIP endpoint
- **Allows Infinity to continue recording entire conversation**
- Both platforms have visibility of full call

---

## 3. Use Case: Missed Calls & Out-of-Hours

### Problem Statement
- Customers lose revenue from unanswered calls
- After-hours calls go to voicemail (poor experience)
- Staff unavailable = missed booking opportunities

### ReceptionMate Solution
**Missed Calls:**
- AI answers after 20-30 seconds (configurable)
- Captures customer details & intent
- Books appointments directly into customer's system
- Staff follow up next business day

**Out-of-Hours:**
- AI handles 100% of after-hours calls
- Provides business information (hours, location, FAQs)
- Emergency routing for urgent cases
- Warm handoff when staff return

### Customer Benefits
- **Zero missed opportunities** - every call answered
- **24/7 availability** - professional service anytime
- **Revenue capture** - bookings even when closed
- **Staff relief** - no after-hours interruptions

---

## 4. Infinity Platform Integration

### What Infinity Retains
✅ **Call tracking number** (customer-facing)
✅ **Billable minutes** (call starts/ends on your number)
✅ **Call recording** (via bridged forwarding)
✅ **Analytics & reporting** (call metadata, duration, outcome)
✅ **Customer relationship** (white-label our AI as your feature)

### What ReceptionMate Provides
✅ **AI agent platform** (voice synthesis, conversation logic)
✅ **Call transcripts** (sent to Infinity via API)
✅ **Call summaries** (sentiment, outcome, next actions)
✅ **Integration data** (pushes to customer CRMs)
✅ **Agent configuration** (per-customer personality, FAQs, tools)

### Data Flow
1. **During call**: Infinity records audio
2. **After call**: ReceptionMate sends structured data to Infinity API:
   - Transcript (full conversation text)
   - Summary (key points, outcome)
   - Metadata (duration, caller details, booking made)
3. **Infinity dashboard**: Shows AI call data alongside human calls

---

## 5. Pilot Program

### Target Metrics
- **Customers**: 5-10 initial pilot customers
- **Volume**: 200k-300k minutes per customer/year
- **Total pilot volume**: ~1-2M minutes/year
- **Use cases**: Missed calls + out-of-hours only

### Pilot Success Criteria
- **Answer rate**: >95% of overflow calls handled by AI
- **Customer satisfaction**: >4/5 rating
- **Booking conversion**: measurable increase vs voicemail
- **Integration reliability**: <1% error rate with Infinity platform

### Pilot Timeline
- **Month 1**: Technical integration & testing
- **Month 2-3**: Onboard 3-5 pilot customers
- **Month 4-6**: Monitor performance, iterate on AI agents
- **Month 7**: Review results, plan full launch

---

## 6. Scaling Roadmap

### Phase 1: Pilot (Months 1-6)
- 5-10 customers
- 1-2M minutes/year
- Missed calls + out-of-hours only

### Phase 2: Initial Scale (Year 1)
- 20-30 customers
- 6-9M minutes/year
- Add use cases: appointment reminders, qualification calls

### Phase 3: Full Scale (Year 2+)
- 50-100+ customers
- 15-30M+ minutes/year
- Expand use cases: sales, support, surveys

### Revenue Projection (Infinity)
Assuming Infinity charges **£0.10/min** for tracking numbers:
- **Pilot**: £100k-£200k annual revenue
- **Phase 2**: £600k-£900k annual revenue
- **Phase 3**: £1.5M-£3M+ annual revenue

*Infinity's existing per-minute revenue is protected — AI adds value without cannibalizing*

---

## 7. Commercial Model

### Partnership Structure
**White-Label Model**: Infinity sells AI as part of their platform

### Pricing Options

#### Option A: Revenue Share
- ReceptionMate charges **£0.03-£0.05/minute** of AI-handled calls
- Infinity charges customer **£0.10-£0.15/minute** (same as human calls)
- **Infinity margin**: £0.05-£0.10/minute

#### Option B: Wholesale Pricing
- ReceptionMate sells minutes to Infinity at **£0.04/minute**
- Infinity resells to customers at **£0.12/minute**
- **Infinity margin**: £0.08/minute (67% margin)

#### Option C: SaaS + Usage
- ReceptionMate charges Infinity:
  - **£500/month** per customer (base platform fee)
  - **£0.02/minute** for AI usage
- Infinity packages as premium feature (£1000+/month to customer)

**Recommendation**: Start with **Option B** (wholesale) for pilot simplicity

### Example Customer Economics (Option B)
**Customer with 250k minutes/year:**
- Infinity pays ReceptionMate: £10,000
- Infinity charges customer: £30,000
- **Infinity gross profit**: £20,000 (67% margin)
- **Customer value**: 24/7 coverage, zero missed calls

---

## 8. Security & Compliance

### Data Security
- **ISO 27001** certified infrastructure (AWS)
- **SOC 2 Type II** compliant (in progress)
- **End-to-end encryption** for call audio
- **GDPR compliant** data handling
- **Data residency**: UK/EU hosting available

### Call Recording & Storage
- Recordings stored in **encrypted S3 buckets**
- **Retention policies** configurable per customer (30-365 days)
- **Access controls** - customer-specific data isolation
- **Audit logs** - all access tracked and logged

### PCI Compliance (if handling payments)
- **No card data stored** in AI system
- Payment collection via **PCI-compliant** integrations (Stripe, GoCardless)
- Tokenization for recurring payments

### Infrastructure
- **AWS**: Multi-region deployment (eu-west-2 primary)
- **LiveKit Cloud**: Enterprise tier with 99.9% SLA
- **Redundancy**: Automatic failover for call routing
- **Monitoring**: 24/7 uptime monitoring & alerting

---

## 9. Technical Requirements from Infinity

### Must-Have
✅ **Bridged SIP forwarding** capability
   - Infinity needs to support SIP re-INVITE or similar
   - Allows Infinity to stay in call path for recording
   - If not possible: we provide recording sync via API

✅ **API access** for data integration
   - POST call transcripts/summaries to Infinity platform
   - GET customer configuration (business hours, routing rules)

✅ **SIP trunk connectivity**
   - Infinity forwards to our LiveKit SIP endpoint
   - Format: `sip:customer-id@livekit.receptionmate.ai`

### Nice-to-Have
- Webhook notifications for call events (start, end, no-answer)
- Dashboard integration (embed ReceptionMate config in Infinity UI)
- Branded customer portal (co-branded setup experience)

---

## 10. Next Steps

### Immediate Actions
1. **Technical discovery call**
   - Confirm Infinity's SIP forwarding capabilities
   - Review API documentation (if available)
   - Discuss webhook/integration requirements

2. **Pilot customer selection**
   - Infinity identifies 3-5 ideal pilot candidates
   - Industries: automotive, healthcare, home services, legal

3. **Commercial agreement**
   - Finalize pricing model (wholesale or revenue share)
   - Define pilot success metrics
   - Sign partnership terms

### Timeline
- **Week 1-2**: Technical integration setup & testing
- **Week 3-4**: Onboard first pilot customer
- **Month 2**: Add 2-3 more pilot customers
- **Month 3-6**: Monitor, iterate, optimize
- **Month 7**: Review results & plan full rollout

---

## Questions for Infinity

1. **SIP Forwarding**: Do you support bridged call forwarding (keeping Infinity in the call path)?
2. **API Access**: Is there an API for us to push call data (transcripts, summaries) to your platform?
3. **Customer Selection**: Which 5-10 customers would be ideal for the pilot?
4. **White-Label**: How would you like to brand this to customers? (Infinity AI, powered by X, etc.)
5. **Pricing Preference**: Revenue share vs. wholesale vs. SaaS model?

---

## Contact Information

**ReceptionMate**
- **CTO**: [Your Name]
- **Email**: [your-email]
- **Demo**: https://receptionmate.ai/demo
- **Technical Docs**: Available upon request

**Meeting with**: Barry Sacks, CTO - Infinity

---

## Appendix: Technical Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    INFINITY PLATFORM                          │
│                                                               │
│  ┌─────────────────┐         ┌──────────────────┐           │
│  │ Tracking Number │────────▶│ Call Routing     │           │
│  │ +44 1234 567890 │         │ Logic Engine     │           │
│  └─────────────────┘         └──────────────────┘           │
│                                      │                        │
│                    ┌─────────────────┴────────────────┐      │
│                    ▼                                   ▼      │
│          ┌──────────────────┐              ┌─────────────┐   │
│          │ Customer Phone   │              │ AI Forward  │   │
│          │ System           │              │ (Bridged)   │   │
│          └──────────────────┘              └─────────────┘   │
│                                                   │           │
│                                                   │           │
│  ┌────────────────────────────────────────────┐  │           │
│  │      Call Recording & Analytics            │  │           │
│  │  • Records both human & AI call legs       │◀─┘           │
│  │  • Receives AI transcripts via API         │              │
│  │  • Customer dashboard shows unified view   │              │
│  └────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ SIP forwarding
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                  RECEPTIONMATE PLATFORM                       │
│                                                               │
│  ┌──────────────────┐       ┌──────────────────┐            │
│  │ LiveKit SIP      │──────▶│ AI Agent Engine  │            │
│  │ Endpoint         │       │ (GPT-4 + Voice)  │            │
│  └──────────────────┘       └──────────────────┘            │
│                                      │                        │
│                                      ▼                        │
│              ┌────────────────────────────────┐              │
│              │  • Appointment Booking         │              │
│              │  • CRM Integration             │              │
│              │  • Call Summary Generation     │              │
│              │  • Transcript + Metadata       │              │
│              └────────────────────────────────┘              │
│                         │                                     │
│                         │ POST to Infinity API               │
│                         ▼                                     │
│              ┌────────────────────────────────┐              │
│              │  Call Data Sync to Infinity    │              │
│              └────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────┘
```

---

**End of Presentation**

*This partnership allows Infinity to offer enterprise-grade AI voice capabilities while maintaining their core telephony revenue model and customer relationships.*
