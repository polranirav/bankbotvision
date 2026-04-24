export type BranchIntentId =
  | "existing"
  | "open-account"
  | "documents"
  | "advisor";

export type BranchIntent = {
  id: BranchIntentId;
  title: string;
  summary: string;
  customerLine: string;
  agentReply: string;
  checklist: string[];
  primaryCta: string;
  primaryHref: (agentName: string) => string;
  secondaryCta: string;
  secondaryHref: (agentName: string) => string;
};

export const BRANCH_INTENTS: BranchIntent[] = [
  {
    id: "existing",
    title: "I already have an account",
    summary: "Recognise me, greet me, and bring me securely into my banking dashboard.",
    customerLine: "Hi, I already bank here and I need help with my account today.",
    agentReply:
      "Perfect. I can verify who you are at this desk first, then bring up your secure banking profile and continue from there.",
    checklist: [
      "Confirm you are an existing customer",
      "Verify identity with Face ID or secure login",
      "Route you into your account dashboard",
    ],
    primaryCta: "Verify with Face ID",
    primaryHref: (agentName) => `/login?agent=${agentName}&mode=face`,
    secondaryCta: "Use email instead",
    secondaryHref: (agentName) => `/login?agent=${agentName}&mode=email`,
  },
  {
    id: "open-account",
    title: "I want to open a new account",
    summary: "Start like a real branch visit, with the desk agent guiding the account-opening journey.",
    customerLine: "Hello, I want to open a new bank account and I need help getting started.",
    agentReply:
      "Absolutely. I’ll walk you through the application the same way a front-desk representative would, then we’ll collect your details and registration.",
    checklist: [
      "Choose the type of account you want to open",
      "Enter your personal details and financial profile",
      "Register Face ID for your future branch visits",
    ],
    primaryCta: "Start account opening",
    primaryHref: (agentName) => `/signup?agent=${agentName}`,
    secondaryCta: "Ask another desk question",
    secondaryHref: (agentName) => `/desk?agent=${agentName}`,
  },
  {
    id: "documents",
    title: "I need help with documents or ID",
    summary: "Use the desk first for passports, ID checks, forms, and branch-style document guidance.",
    customerLine: "I brought my documents with me and I need help with ID or branch paperwork.",
    agentReply:
      "That’s exactly what the front desk is for. I’ll guide you to the right secure sign-in step first, then we can continue with your documents and service request.",
    checklist: [
      "Tell the desk agent what document or form you have",
      "Securely verify your identity",
      "Continue with the right banking workflow after sign-in",
    ],
    primaryCta: "Continue to secure desk help",
    primaryHref: (agentName) => `/login?agent=${agentName}&mode=choose`,
    secondaryCta: "I already have Face ID",
    secondaryHref: (agentName) => `/login?agent=${agentName}&mode=face`,
  },
  {
    id: "advisor",
    title: "I want to speak with someone about banking options",
    summary: "Talk through cards, accounts, savings, or next steps before diving into a secure workflow.",
    customerLine: "I want to talk to someone about the best banking option for me today.",
    agentReply:
      "Of course. We can start with a short front-desk conversation, then I’ll send you to the right secure service once we know what you need.",
    checklist: [
      "Start with a branch-style conversation at the desk",
      "Choose the right banking path for your goal",
      "Move into secure sign-in when account details are needed",
    ],
    primaryCta: "Go to guided login",
    primaryHref: (agentName) => `/login?agent=${agentName}&mode=choose`,
    secondaryCta: "Open a new account instead",
    secondaryHref: (agentName) => `/signup?agent=${agentName}`,
  },
];

export function getBranchIntent(intentId: string | null | undefined) {
  return BRANCH_INTENTS.find((intent) => intent.id === intentId);
}
