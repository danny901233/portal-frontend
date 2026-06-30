'use client';

import { useState, useEffect } from 'react';
import { getSessionToken } from '../lib/auth';
import { cn } from '../lib/utils';

interface ConversationTags {
  messageType?: string;
  confirmedBooking?: boolean;
  confirmedBookingCategory?: 'service' | 'diagnostic' | 'mot' | 'other' | null;
  capturedRevenue?: number | null;
  bookingDetails?: string;
  tags?: string[];
}

interface ConversationTaggingPanelProps {
  conversationId: string;
  initialTags: ConversationTags;
  onUpdate: (tags: ConversationTags) => void;
}

export default function ConversationTaggingPanel({
  conversationId,
  initialTags,
  onUpdate,
}: ConversationTaggingPanelProps) {
  const [tags, setTags] = useState<ConversationTags>(initialTags);
  const [saving, setSaving] = useState(false);
  const [newTag, setNewTag] = useState('');

  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = getSessionToken();
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/conversations/${conversationId}/tags`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(tags),
        }
      );

      if (!response.ok) throw new Error('Failed to save tags');

      const data = await response.json();
      onUpdate(data.conversation);
    } catch (error) {
      console.error('Error saving tags:', error);
      alert('Failed to save tags');
    } finally {
      setSaving(false);
    }
  };

  const addTag = () => {
    if (newTag.trim() && !tags.tags?.includes(newTag.trim())) {
      setTags({
        ...tags,
        tags: [...(tags.tags || []), newTag.trim()],
      });
      setNewTag('');
    }
  };

  const removeTag = (tagToRemove: string) => {
    setTags({
      ...tags,
      tags: tags.tags?.filter((t) => t !== tagToRemove),
    });
  };

  return (
    <div className="w-80 bg-white border-l border-slate-200 p-4 overflow-y-auto">
      <h3 className="text-lg font-semibold text-slate-900 mb-4">Conversation Details</h3>

      <div className="space-y-4">
        {/* Message Type */}
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-2">
            Message Type
          </label>
          <select
            value={tags.messageType || ''}
            onChange={(e) => setTags({ ...tags, messageType: e.target.value })}
            className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="">Select type...</option>
            <option value="inquiry">Inquiry</option>
            <option value="booking">Booking</option>
            <option value="complaint">Complaint</option>
            <option value="followup">Follow-up</option>
            <option value="quote">Quote Request</option>
            <option value="other">Other</option>
          </select>
        </div>

        {/* Confirmed Booking */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tags.confirmedBooking || false}
              onChange={(e) => setTags({ ...tags, confirmedBooking: e.target.checked })}
              className="w-4 h-4 rounded border-slate-300 bg-slate-100 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-sm font-medium text-slate-600">Confirmed Booking</span>
          </label>
        </div>

        {/* Booking Category */}
        {tags.confirmedBooking && (
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">
              Booking Category
            </label>
            <select
              value={tags.confirmedBookingCategory || ''}
              onChange={(e) =>
                setTags({
                  ...tags,
                  confirmedBookingCategory: e.target.value as any,
                })
              }
              className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              <option value="">Select category...</option>
              <option value="service">Service</option>
              <option value="diagnostic">Diagnostic</option>
              <option value="mot">MOT</option>
              <option value="other">Other</option>
            </select>
          </div>
        )}

        {/* Captured Revenue */}
        {tags.confirmedBooking && (
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">
              Captured Revenue (£)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={tags.capturedRevenue || ''}
              onChange={(e) =>
                setTags({
                  ...tags,
                  capturedRevenue: e.target.value ? parseFloat(e.target.value) : null,
                })
              }
              placeholder="0.00"
              className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
        )}

        {/* Booking Details */}
        {tags.confirmedBooking && (
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">
              Booking Details
            </label>
            <textarea
              value={tags.bookingDetails || ''}
              onChange={(e) => setTags({ ...tags, bookingDetails: e.target.value })}
              placeholder="Add notes about the booking..."
              rows={3}
              className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
            />
          </div>
        )}

        {/* Custom Tags */}
        <div>
          <label className="block text-sm font-medium text-slate-600 mb-2">Custom Tags</label>
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && addTag()}
              placeholder="Add a tag..."
              className="flex-1 px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <button
              onClick={addTag}
              className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors"
            >
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.tags?.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-full"
              >
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-slate-900"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save Tags'}
        </button>
      </div>
    </div>
  );
}
