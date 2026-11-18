// How often a Sendclap tier charges, in the words its price is shown with (support.tsx). Sendclap memberships bill
// by the week, the month or the year (`interval`); a tier must never read "/mo" when it charges once a year. `t` is
// i18n.ts's, passed in so this stays testable without a browser.
type T = (s: string, vars?: Record<string, string | number>) => string

/** The tier's price with its billing period: "$5/mo", "$50/yr"; one we don't know shows the bare price. */
export const perPeriod = (t: T, price: string, interval: string) =>
  interval === 'month' ? t('{price}/mo', { price })
  : interval === 'year' ? t('{price}/yr', { price })
  : interval === 'week' ? t('{price}/wk', { price })
  : price

/** The second tap's question before joining a tier: what it costs and how often. */
export const joinAsk = (t: T, price: string, interval: string) =>
  interval === 'month' ? t('Join for {price} a month?', { price })
  : interval === 'year' ? t('Join for {price} a year?', { price })
  : interval === 'week' ? t('Join for {price} a week?', { price })
  : t('Join for {price}?', { price })
