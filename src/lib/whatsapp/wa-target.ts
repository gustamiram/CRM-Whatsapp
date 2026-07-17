/**
 * Resolve the string a WhatsAppProvider's `to` should target for a
 * contact.
 *
 * Normally this is just the contact's sanitized phone number. But when
 * WhatsApp only ever gave us a LID for this contact (no phone-number
 * resolution — see inbound-core.ts / the UAZAPI webhook parser),
 * `contact.wa_lid` is set and the phone column holds the LID's digits,
 * which isn't a dialable number. UAZAPI's `/send/*` `number` field
 * accepts an explicit `{id}@lid` form for exactly this case, so route
 * there instead of guessing a phone-based JID that will fail with
 * "no LID found ... from server".
 *
 * `wa_lid` is only ever set on UAZAPI-originated contacts, so this is a
 * no-op for Meta (contact.wa_lid is always null there).
 */
export function resolveSendTarget(
  contact: { wa_lid?: string | null },
  sanitizedPhone: string
): string {
  return contact.wa_lid ? `${contact.wa_lid}@lid` : sanitizedPhone;
}
