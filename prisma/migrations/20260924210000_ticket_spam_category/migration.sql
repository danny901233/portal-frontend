-- Tickets can now be filed as spam: cold outreach, bulk marketing, blocked senders.
ALTER TYPE "TicketCategory" ADD VALUE IF NOT EXISTS 'spam';
