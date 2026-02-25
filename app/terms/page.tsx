export default function TermsAndConditionsPage() {
  return (
    <div className="min-h-screen bg-slate-950 py-12 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-slate-900/40">
          <div className="mb-8">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate Logo"
              className="mx-auto h-16 w-auto"
            />
          </div>

          <h1 className="mb-8 text-center text-3xl font-bold text-slate-100">
            Terms and Conditions
          </h1>

          <div className="space-y-6 text-slate-300">
            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">1. Introduction</h2>
              <p className="leading-relaxed">
                These Terms and Conditions govern your use of ReceptionMate's AI-powered voice reception services 
                (the "Service"). By accessing or using our Service, you agree to be bound by these Terms.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">2. Service Description</h2>
              <p className="leading-relaxed">
                ReceptionMate provides AI-powered telephone reception and booking services for automotive service 
                businesses. The Service includes call handling, appointment booking, message taking, and integration 
                with garage management systems.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">3. Account Registration</h2>
              <p className="leading-relaxed mb-2">
                To use the Service, you must:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Provide accurate and complete registration information</li>
                <li>Maintain the security of your account credentials</li>
                <li>Notify us immediately of any unauthorized access</li>
                <li>Be responsible for all activities under your account</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">4. Subscription and Payment</h2>
              <p className="leading-relaxed mb-2">
                Our Service operates on a subscription basis:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Monthly subscription fees are charged via Direct Debit through GoCardless</li>
                <li>Additional usage charges apply based on call minutes consumed</li>
                <li>Prices are displayed in British Pounds (GBP) and include VAT where applicable</li>
                <li>Payment is due on your billing cycle date each month</li>
                <li>Failed payments may result in service suspension</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">5. Cancellation and Refunds</h2>
              <p className="leading-relaxed mb-2">
                You may cancel your subscription at any time:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Cancellation takes effect at the end of your current billing period</li>
                <li>No refunds are provided for partial billing periods</li>
                <li>Usage charges are non-refundable</li>
                <li>You retain access to the Service until the end of the paid period</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">6. Service Level and Availability</h2>
              <p className="leading-relaxed mb-2">
                We strive to provide reliable service but cannot guarantee:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Uninterrupted or error-free operation</li>
                <li>100% accuracy in AI-generated responses or bookings</li>
                <li>Prevention of all unauthorized access or data loss</li>
              </ul>
              <p className="mt-2 leading-relaxed">
                We are not liable for service interruptions due to maintenance, technical issues, or third-party 
                service failures (including telephone networks, cloud providers, or integration partners).
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">7. Data and Privacy</h2>
              <p className="leading-relaxed mb-2">
                Your use of the Service involves:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Recording of telephone conversations for quality and training purposes</li>
                <li>Storage of customer contact information and booking details</li>
                <li>Processing of call transcripts and summaries</li>
                <li>Sharing data with integrated third-party systems (e.g., Garage Hive)</li>
              </ul>
              <p className="mt-2 leading-relaxed">
                We process data in accordance with UK GDPR and our Privacy Policy. You are responsible for 
                obtaining necessary consents from your customers for call recording and data processing.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">8. Acceptable Use</h2>
              <p className="leading-relaxed mb-2">
                You agree not to:
              </p>
              <ul className="list-disc space-y-1 pl-6">
                <li>Use the Service for unlawful purposes or to violate any regulations</li>
                <li>Attempt to reverse engineer, decompile, or access the Service's source code</li>
                <li>Overload or interfere with the Service's infrastructure</li>
                <li>Resell or redistribute the Service without authorization</li>
                <li>Use automated systems to abuse the Service</li>
              </ul>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">9. Intellectual Property</h2>
              <p className="leading-relaxed">
                All intellectual property rights in the Service, including software, designs, trademarks, and 
                content, remain the property of ReceptionMate or its licensors. You receive only a limited 
                license to use the Service as described in these Terms.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">10. Limitation of Liability</h2>
              <p className="leading-relaxed">
                To the maximum extent permitted by law, ReceptionMate shall not be liable for any indirect, 
                incidental, consequential, or punitive damages arising from your use of the Service. Our total 
                liability for any claim shall not exceed the amount you paid for the Service in the 12 months 
                preceding the claim.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">11. Modifications to Terms</h2>
              <p className="leading-relaxed">
                We may modify these Terms at any time by posting updated terms on this page. Continued use of 
                the Service after changes constitutes acceptance of the modified Terms. We will notify you of 
                material changes via email or through the Service.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">12. Termination</h2>
              <p className="leading-relaxed">
                We may suspend or terminate your access to the Service immediately if you breach these Terms, 
                fail to pay fees, or engage in fraudulent or abusive behavior. Upon termination, you must cease 
                using the Service and may lose access to your data.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">13. Governing Law</h2>
              <p className="leading-relaxed">
                These Terms are governed by the laws of England and Wales. Any disputes shall be subject to the 
                exclusive jurisdiction of the courts of England and Wales.
              </p>
            </section>

            <section>
              <h2 className="mb-3 text-xl font-semibold text-slate-100">14. Contact Information</h2>
              <p className="leading-relaxed">
                For questions about these Terms, please contact us at:
              </p>
              <div className="mt-2 rounded-lg bg-slate-800/50 p-4">
                <p className="font-medium text-slate-100">ReceptionMate</p>
                <p>Email: <a href="mailto:admin@receptionmate.ai" className="text-sky-400 hover:text-sky-300">admin@receptionmate.ai</a></p>
                <p>Website: <a href="https://portal.receptionmate.co.uk" className="text-sky-400 hover:text-sky-300">portal.receptionmate.co.uk</a></p>
              </div>
            </section>

            <div className="mt-8 border-t border-slate-700 pt-6 text-center text-sm text-slate-400">
              <p>Last updated: February 25, 2026</p>
              <p className="mt-2">© 2026 ReceptionMate. All rights reserved.</p>
            </div>
          </div>

          <div className="mt-8 text-center">
            <a
              href="/login"
              className="inline-block rounded-lg bg-sky-500 px-6 py-3 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Back to Portal
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
