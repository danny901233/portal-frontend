'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Poppins } from 'next/font/google';
import {
  Activity,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FileText,
  HelpCircle,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Mic,
  Phone,
  Plug,
  Send,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Target,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['600'],
  display: 'swap',
});

type NavLeaf = {
  name: string;
  href: string;
  icon: LucideIcon;
  badge?: 'messages';
  requiresMessaging?: boolean;
  requiresManager?: boolean;
  requiresStaff?: boolean;
};

type NavGroupItem = NavLeaf | NavParent;
type NavParent = {
  name: string;
  icon: LucideIcon;
  children: NavLeaf[];
  requiresManager?: boolean;
};

type NavSection = {
  group: string;
  items: NavGroupItem[];
  requiresStaff?: boolean;
};

const isParent = (item: NavGroupItem): item is NavParent => 'children' in item;

const agentParent: NavParent = {
  name: 'Agent',
  icon: Bot,
  requiresManager: true,
  children: [
    { name: 'Greeting', href: '/agent-configurations', icon: Sparkles },
    { name: 'FAQs', href: '/jodie-sample?tab=faqs', icon: HelpCircle },
    { name: 'Rules', href: '/jodie-sample?tab=rules', icon: Shield },
    { name: 'Capture fields', href: '/jodie-sample?tab=capture', icon: FileText },
    { name: 'Smart goals', href: '/jodie-sample?tab=goals', icon: Target },
    { name: 'Pronunciations', href: '/jodie-sample?tab=pronunciations', icon: Mic },
    { name: 'Knowledge', href: '/agent-configurations', icon: BookOpen },
  ],
};

const primarySection: NavSection = {
  group: 'Primary',
  items: [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Calls', href: '/calls', icon: Phone },
    { name: 'Messages', href: '/messages', icon: MessageSquare, badge: 'messages', requiresMessaging: true },
    { name: 'Customers', href: '/jodie-sample?tab=agent-index', icon: Users },
  ],
};

const settingsSection: NavSection = {
  group: 'Settings',
  items: [
    agentParent,
    { name: 'Channels & integrations', href: '/integrations', icon: Plug },
    { name: 'Templates', href: '/templates', icon: FileText, requiresMessaging: true },
    { name: 'Outbound', href: '/outbound', icon: Send, requiresMessaging: true },
    { name: 'Team', href: '/team', icon: Users, requiresManager: true },
    { name: 'Billing', href: '/billing', icon: CreditCard },
  ],
};

const adminSection: NavSection = {
  group: 'Staff only',
  requiresStaff: true,
  items: [
    { name: 'Observability', href: '/observability', icon: Activity, requiresStaff: true },
    { name: 'Admin', href: '/admin', icon: SettingsIcon, requiresStaff: true },
  ],
};

const supportLinks: NavLeaf[] = [{ name: 'Help & guides', href: '/help', icon: HelpCircle }];

export default function Sidebar({
  activePath,
  showAdminLink = false,
  hasMessagingAccess = false,
  hasManagerAccess = false,
  isManagerUser = false,
  messagesNeedingAttention = 0,
  isMobileOpen = false,
  onMobileClose,
}: {
  activePath: string;
  showAdminLink?: boolean;
  hasMessagingAccess?: boolean;
  hasManagerAccess?: boolean;
  isManagerUser?: boolean;
  messagesNeedingAttention?: number;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const filterLeaf = (item: NavLeaf): NavLeaf | null => {
    if (item.requiresMessaging && !hasMessagingAccess) return null;
    if (item.requiresManager && !isManagerUser) return null;
    if (item.requiresStaff && !showAdminLink) return null;
    if (item.href === '/billing' && !hasManagerAccess) return null;
    return item;
  };

  const filterItem = (item: NavGroupItem): NavGroupItem | null => {
    if (isParent(item)) {
      if (item.requiresManager && !isManagerUser) return null;
      const filteredChildren = item.children.map(filterLeaf).filter((c): c is NavLeaf => c !== null);
      if (filteredChildren.length === 0) return null;
      return { ...item, children: filteredChildren };
    }
    return filterLeaf(item);
  };

  const sections = useMemo(() => {
    const candidate: NavSection[] = [
      { ...primarySection, items: primarySection.items.map(filterItem).filter((i): i is NavGroupItem => i !== null) },
      { ...settingsSection, items: settingsSection.items.map(filterItem).filter((i): i is NavGroupItem => i !== null) },
    ];
    if (showAdminLink) {
      candidate.push({ ...adminSection, items: adminSection.items.map(filterItem).filter((i): i is NavGroupItem => i !== null) });
    }
    return candidate.filter((section) => section.items.length > 0);
  }, [showAdminLink, hasMessagingAccess, hasManagerAccess, isManagerUser]);

  const isLeafActive = (href: string) =>
    href === activePath ||
    (href.startsWith('/jodie-sample') && activePath.startsWith('/jodie-sample'));

  const isParentActive = (parent: NavParent) =>
    parent.children.some((child) => isLeafActive(child.href));

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setExpanded((prev) => {
      const next = { ...prev };
      for (const section of sections) {
        for (const item of section.items) {
          if (isParent(item) && isParentActive(item)) {
            next[item.name] = true;
          }
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, sections.length]);

  const toggle = (name: string) =>
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));

  const renderLeaf = (item: NavLeaf, indent = false) => {
    const Icon = item.icon;
    const active = isLeafActive(item.href);
    return (
      <Link
        key={`leaf-${item.name}-${item.href}`}
        href={item.href}
        onClick={() => onMobileClose?.()}
        className={cn(
          'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors',
          indent && 'ml-4 py-1.5 text-[13px]',
          active
            ? 'bg-blue-500/15 text-blue-100 ring-1 ring-blue-500/30'
            : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-100',
        )}
      >
        <Icon
          className={cn(
            'h-4 w-4 shrink-0 transition-colors',
            active ? 'text-blue-300' : 'text-slate-500 group-hover:text-slate-300',
          )}
        />
        <span className="flex-1 truncate">{item.name}</span>
        {item.badge === 'messages' && messagesNeedingAttention > 0 && (
          <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">
            {messagesNeedingAttention > 99 ? '99+' : messagesNeedingAttention}
          </span>
        )}
      </Link>
    );
  };

  const renderParent = (parent: NavParent) => {
    const ParentIcon = parent.icon;
    const isOpen = expanded[parent.name] || isParentActive(parent);
    return (
      <div key={`parent-${parent.name}`}>
        <button
          type="button"
          onClick={() => toggle(parent.name)}
          className={cn(
            'group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors',
            isParentActive(parent)
              ? 'text-slate-100'
              : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-100',
          )}
        >
          <ParentIcon
            className={cn(
              'h-4 w-4 shrink-0',
              isParentActive(parent) ? 'text-blue-300' : 'text-slate-500 group-hover:text-slate-300',
            )}
          />
          <span className="flex-1 text-left">{parent.name}</span>
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
          )}
        </button>
        {isOpen && (
          <div className="mt-0.5 space-y-0.5">
            {parent.children.map((child) => renderLeaf(child, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Mobile backdrop */}
      <div
        onClick={onMobileClose}
        className={cn(
          'fixed inset-0 z-30 bg-black/60 backdrop-blur-sm transition-opacity md:hidden',
          isMobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-hidden="true"
      />
    <aside className={cn(
      'fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-800/80 bg-slate-950 transition-transform md:static md:w-64 md:translate-x-0',
      isMobileOpen ? 'translate-x-0' : '-translate-x-full',
    )}>
      <div className="relative flex flex-col items-center justify-center border-b border-slate-800/80 px-5 py-6 text-center">
        <button
          type="button"
          onClick={onMobileClose}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 md:hidden"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>
        <img
          src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
          alt="ReceptionMate"
          className="h-20 w-auto"
        />
        <p
          className={cn(
            'mt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-200',
            poppins.className,
          )}
        >
          <span className="block italic">“Turn missed calls into</span>
          <span className="block italic">new opportunities”</span>
        </p>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {sections.map((section) => (
          <div key={section.group} className="space-y-1">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {section.group}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (isParent(item) ? renderParent(item) : renderLeaf(item)))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-slate-800/80 px-3 py-4">
        <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Support
        </div>
        <div className="space-y-1">
          {supportLinks.map((item) => renderLeaf(item))}
        </div>
      </div>
      <div className="border-t border-slate-800/80 px-5 py-4 text-[11px] text-slate-500">
        © {new Date().getFullYear()} ReceptionMate
      </div>
    </aside>
    </>
  );
}
