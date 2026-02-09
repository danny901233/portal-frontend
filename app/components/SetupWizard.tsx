'use client';

import { useState, useEffect } from 'react';
import { completeSetupWizard, fetchOnboardingInitialData, type OnboardingInitialData } from '../lib/onboarding';
import WizardStep1Welcome from './SetupWizard/WizardStep1Welcome';
import WizardStep2BranchDetails from './SetupWizard/WizardStep2BranchDetails';
import WizardStep3OpeningHours from './SetupWizard/WizardStep3OpeningHours';
import WizardStep4Voice from './SetupWizard/WizardStep4Voice';
import WizardStep5Greeting from './SetupWizard/WizardStep5Greeting';
import WizardStep6BookingPreferences from './SetupWizard/WizardStep6BookingPreferences';
import WizardStep7SmsLinks from './SetupWizard/WizardStep7SmsLinks';
import WizardStep8Notifications from './SetupWizard/WizardStep8Notifications';
import WizardStep9Billing from './SetupWizard/WizardStep9Billing';
import WizardStep10Complete from './SetupWizard/WizardStep10Complete';

export type WizardStep =
  | 'welcome'
  | 'branch-details'
  | 'opening-hours'
  | 'voice'
  | 'greeting'
  | 'booking-preferences'
  | 'sms-links'
  | 'notifications'
  | 'billing'
  | 'complete';

export interface WizardData {
  // Step 2: Branch Details
  branchName: string;
  phoneNumber: string;
  emailAddress: string;
  branchAddress: string;
  websiteUrl: string;

  // Step 3: Opening Hours
  weeklyOpeningHours: any;
  holidayClosures: string;

  // Step 4: Voice
  voice: string;

  // Step 5: Greeting
  greetingLine: string;

  // Step 6: Booking Preferences
  allowFastFitOnly: boolean;

  // Step 7: SMS (conditional)
  enableSmsBookingLinks: boolean;

  // Step 8: Notifications
  notificationEmails: string[];

  // Step 9: Billing
  billingAddress: string;
  billingCity: string;
  billingPostcode: string;
  billingCountry: string;
  vatNumber: string;
  companyRegNumber: string;
  billingEmail: string;
}

interface SetupWizardProps {
  isOpen: boolean;
  garageId: string;
  agentType: 'assist' | 'automate';
  onComplete: () => void;
}

export default function SetupWizard({ isOpen, garageId, agentType, onComplete }: SetupWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const [isLoading, setIsLoading] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const [formData, setFormData] = useState<WizardData>({
    branchName: '',
    phoneNumber: '',
    emailAddress: '',
    branchAddress: '',
    websiteUrl: '',
    weeklyOpeningHours: {
      monday: { open: null, close: null, closed: true },
      tuesday: { open: null, close: null, closed: true },
      wednesday: { open: null, close: null, closed: true },
      thursday: { open: null, close: null, closed: true },
      friday: { open: null, close: null, closed: true },
      saturday: { open: null, close: null, closed: true },
      sunday: { open: null, close: null, closed: true },
    },
    holidayClosures: '',
    voice: 'leah',
    greetingLine: '',
    allowFastFitOnly: false,
    enableSmsBookingLinks: true,
    notificationEmails: [],
    billingAddress: '',
    billingCity: '',
    billingPostcode: '',
    billingCountry: 'United Kingdom',
    vatNumber: '',
    companyRegNumber: '',
    billingEmail: '',
  });
  const [twilioNumber, setTwilioNumber] = useState<string | null>(null);

  // Fetch initial data for pre-population
  useEffect(() => {
    if (isOpen) {
      fetchOnboardingInitialData()
        .then((data: OnboardingInitialData) => {
          // Pre-populate form data
          if (data.agentConfiguration) {
            // Check if weeklyOpeningHours is valid (has at least one day defined)
            const hasValidHours = data.agentConfiguration?.weeklyOpeningHours &&
              Object.keys(data.agentConfiguration.weeklyOpeningHours).length > 0;

            setFormData((prev) => ({
              ...prev,
              branchName: data.agentConfiguration?.branchName || prev.branchName,
              phoneNumber: data.agentConfiguration?.phoneNumber || prev.phoneNumber,
              emailAddress: data.agentConfiguration?.emailAddress || prev.emailAddress,
              branchAddress: data.agentConfiguration?.branchAddress || prev.branchAddress,
              websiteUrl: data.agentConfiguration?.websiteUrl || prev.websiteUrl,
              weeklyOpeningHours: hasValidHours ? data.agentConfiguration!.weeklyOpeningHours : prev.weeklyOpeningHours,
              holidayClosures: data.agentConfiguration?.holidayClosures || prev.holidayClosures,
              greetingLine: data.agentConfiguration?.greetingLine || prev.greetingLine,
              voice: data.agentConfiguration?.voice || prev.voice,
              allowFastFitOnly: data.agentConfiguration?.allowFastFitOnly ?? prev.allowFastFitOnly,
              enableSmsBookingLinks: data.agentConfiguration?.enableSmsBookingLinks ?? prev.enableSmsBookingLinks,
              notificationEmails: data.agentConfiguration?.notificationEmails || prev.notificationEmails,
            }));
          }

          if (data.businessInfo) {
            setFormData((prev) => ({
              ...prev,
              billingAddress: data.businessInfo?.billingAddress || prev.billingAddress,
              billingCity: data.businessInfo?.billingCity || prev.billingCity,
              billingPostcode: data.businessInfo?.billingPostcode || prev.billingPostcode,
              billingCountry: data.businessInfo?.billingCountry || prev.billingCountry,
              vatNumber: data.businessInfo?.vatNumber || prev.vatNumber,
              companyRegNumber: data.businessInfo?.companyRegNumber || prev.companyRegNumber,
              billingEmail: data.businessInfo?.billingEmail || prev.billingEmail,
            }));
          }

          setTwilioNumber(data.twilioNumber || null);
          setIsLoading(false);
        })
        .catch((error) => {
          console.error('Failed to fetch initial data:', error);
          setIsLoading(false);
        });
    }
  }, [isOpen]);

  const stepOrder: WizardStep[] = [
    'welcome',
    'branch-details',
    'opening-hours',
    'voice',
    'greeting',
    'booking-preferences',
    ...(agentType === 'assist' ? ['sms-links' as WizardStep] : []),
    'notifications',
    'billing',
    'complete',
  ];

  const currentStepIndex = stepOrder.indexOf(currentStep);
  const totalSteps = stepOrder.length;

  const handleNext = () => {
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < stepOrder.length) {
      setCurrentStep(stepOrder[nextIndex]);
    }
  };

  const handlePrevious = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(stepOrder[prevIndex]);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      await completeSetupWizard();
      onComplete();
    } catch (error) {
      console.error('Failed to complete wizard:', error);
      alert('Failed to complete setup. Please try again.');
      setIsCompleting(false);
    }
  };

  const updateFormData = (updates: Partial<WizardData>) => {
    setFormData((prev) => ({ ...prev, ...updates }));
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Progress Bar */}
        <div className="border-b border-slate-800 px-6 py-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-slate-300">
              Step {currentStepIndex + 1} of {totalSteps}
            </span>
            <span className="text-slate-500">
              {Math.round(((currentStepIndex + 1) / totalSteps) * 100)}% Complete
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${((currentStepIndex + 1) / totalSteps) * 100}%` }}
            />
          </div>
        </div>

        {/* Content Area */}
        <div className="max-h-[calc(100vh-16rem)] overflow-y-auto px-6 py-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <svg
                  className="mx-auto h-12 w-12 animate-spin text-blue-600"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <p className="mt-4 text-slate-400">Loading your setup...</p>
              </div>
            </div>
          ) : (
            <>
              {currentStep === 'welcome' && <WizardStep1Welcome onNext={handleNext} />}
              {currentStep === 'branch-details' && (
                <WizardStep2BranchDetails
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'opening-hours' && (
                <WizardStep3OpeningHours
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'voice' && (
                <WizardStep4Voice
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  greetingText={formData.greetingLine}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'greeting' && (
                <WizardStep5Greeting
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  branchName={formData.branchName}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'booking-preferences' && (
                <WizardStep6BookingPreferences
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'sms-links' && agentType === 'assist' && (
                <WizardStep7SmsLinks
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'notifications' && (
                <WizardStep8Notifications
                  data={formData}
                  updateData={updateFormData}
                  garageId={garageId}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'billing' && (
                <WizardStep9Billing
                  data={formData}
                  updateData={updateFormData}
                  branchName={formData.branchName}
                  onNext={handleNext}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep === 'complete' && (
                <WizardStep10Complete
                  twilioNumber={twilioNumber}
                  onComplete={handleComplete}
                  onPrevious={handlePrevious}
                  isCompleting={isCompleting}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
