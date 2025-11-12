// src/app/home-clean/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import { collection, getDoc, doc, setDoc, getDocs, query, where } from 'firebase/firestore';

// avoid TS error if ZapUrl isn't defined in env (your build log issue)
declare const ZapUrl: string | undefined;

// Normalize staff day availability regardless of how it's stored
type AnyAvail = { available?: boolean; startTime?: string; endTime?: string; from?: string; to?: string } | undefined | null;
const titleCaseDay = (lower: string) => lower.charAt(0).toUpperCase() + lower.slice(1);

/** Try lower-case day first ("monday"), then Title-case ("Monday"). Returns a unified shape. */
function getDayAvail(availObj: unknown, weekdayLower: string): { available: boolean; start: string; end: string } | null {
  if (!availObj || typeof availObj !== 'object') return null;
  const obj = availObj as Record<string, unknown>;
  const a = (obj[weekdayLower] ?? obj[titleCaseDay(weekdayLower)]) as AnyAvail;
  if (!a || typeof a !== 'object') return null;

  const aRec = a as Record<string, unknown>;
  const available = !!aRec.available;
  const start = (aRec.startTime as string | undefined) || (aRec.from as string | undefined) || '07:00';
  const end = (aRec.endTime as string | undefined) || (aRec.to as string | undefined) || '20:00';
  return { available, start, end };
}

// ----------- UI helpers -----------
const PRIMARY = '#0071bc'; // only blue used
const DATE_BG = '#4caf50';
const UNAVAILABLE_BG = '#f1f1f1';
const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const monthNames = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const ALL_TIMES = ['7','8','9','10','11','12','13','14','15','16','17','18','19','20'];

// --- booking helpers ---
function addHoursToTime(hhmm: string, hoursFloat: number) {
  const [hStr, mStr] = hhmm.split(':');
  let minutes = parseInt(hStr, 10) * 60 + parseInt(mStr || '0', 10);
  minutes += Math.round((hoursFloat || 0) * 60);
  const endH = Math.floor(minutes / 60);
  const endM = minutes % 60;
  return `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`;
}
function createOrderId() {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `LUX${n}`;
}
function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function displayDate(d?: Date | null) {
  if (!d) return 'No date selected';
  return `${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
}
function displayHour(hStr: string) {
  const h = parseInt(hStr, 10);
  const twelve = h > 12 ? h - 12 : h;
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${twelve}:00 ${ap}`;
}
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });

// ================= PRICING =================
const HOURLY_RATE = 28;
const MIN_HOURS = 2;
const SUPPLIES_FEE = 5;
const HOURS_WEIGHTS = { bedrooms: 1.0, livingRooms: 1.0, kitchens: 1.0, bathrooms: 1.0, utilityRooms: 0.5, additionalRoomEach: 0.5 };
const CLEAN_MULTIPLIER: Record<string, number> = { 'quite-clean': 0.9, 'average': 1.0, 'quite-dirty': 1.25, 'filthy': 1.6 };
const TEAM_THRESHOLD_HOURS = 4;
const TEAM_FACTOR = 1.6;
function roundUpToHalf(x: number) { return Math.ceil(x * 2) / 2; }

// small time helpers
const timeToMinutes = (t: string) => {
  const [hh, mm='0'] = t.split(':'); return parseInt(hh,10)*60 + parseInt(mm,10);
};
const within = (x: number, a: number, b: number) => x >= a && x < b;

export default function Page() {
  // date range
  const now = new Date();
  now.setHours(0,0,0,0);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const maxMonth = new Date(now.getFullYear(), now.getMonth() + 3, 1);

  const [viewMonth, setViewMonth] = useState<Date>(startMonth);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [availableTimes, setAvailableTimes] = useState<string[]>([]);
  const [timesLoading, setTimesLoading] = useState(false);
  const [blockedDates, setBlockedDates] = useState<Set<string>>(new Set());

  // ------- FORM STATE (unchanged keys) -------
  const [form, setForm] = useState({
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    bedrooms: '',
    livingRooms: '',
    kitchens: '',
    bathrooms: '',
    utilityRooms: '',
    cleanliness: '',
    additionalRooms: [] as string[],
    addOns: [] as string[],
    products: '',
    additionalInfo: '',
    addressLine1: '',
    addressLine2: '',
    town: '',
    county: '',
    postcode: '',
    serviceType: 'Cleaning Service',
    access: '',
    keyLocation: '',
  });

  // ---- multi-section flow (NEW) ----
  // We keep Personal Information always visible.
  // The rest of the main form is split into steps with a simple slide-in animation.
  type StepKey =
    | 'address'
    | 'access'
    | 'property'
    | 'additionalRooms'
    | 'addOns';
  const STEPS: StepKey[] = ['address','access','property','additionalRooms','addOns'];
  const [step, setStep] = useState<number>(0);

  const nextStep = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const prevStep = () => setStep(s => Math.max(s - 1, 0));

  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const name = target.name;
    const value = target.value;
    const type = target.type;
    const checked = (target as HTMLInputElement).checked;

    if (type === 'checkbox' && (name === 'additionalRooms' || name === 'addOns')) {
      setForm((p) => {
        const prev = p as unknown as Record<string, unknown>;
        const currentList = Array.isArray(prev[name]) ? (prev[name] as unknown as string[]) : [];
        const setA = new Set(currentList);
        if (checked) setA.add(value); else setA.delete(value);
        return { ...p, [name]: Array.from(setA) } as typeof p;
      });
    } else {
      setForm((p) => ({ ...p, [name]: value }));
    }
  };

  // ---- Calendar grid (unchanged) ----
  const grid = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
    const cells: { d: number; date?: Date; muted?: boolean }[] = [];
    for (let i = 0; i < startOffset; i++) cells.push({ d: 0, muted: true });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ d, date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d) });
    while (cells.length % 7) cells.push({ d: 0, muted: true });
    return cells;
  }, [viewMonth]);

  // ---- Pricing (unchanged maths; updated add-ons list) ----
  const pricing = useMemo(() => {
    const n = (s: string) => (s ? parseInt(s, 10) : 0);
    const bedrooms = n(form.bedrooms);
    const livingRooms = n(form.livingRooms);
    const kitchens = n(form.kitchens);
    const bathrooms = n(form.bathrooms);
    const utilityRooms = n(form.utilityRooms);
    const additionalRoomsCount = form.additionalRooms.length;

    let rawHours =
      bedrooms * HOURS_WEIGHTS.bedrooms +
      livingRooms * HOURS_WEIGHTS.livingRooms +
      kitchens * HOURS_WEIGHTS.kitchens +
      bathrooms * HOURS_WEIGHTS.bathrooms +
      utilityRooms * HOURS_WEIGHTS.utilityRooms +
      additionalRoomsCount * HOURS_WEIGHTS.additionalRoomEach;

    const mult = form.cleanliness ? (CLEAN_MULTIPLIER[form.cleanliness] ?? 1) : 1;
    rawHours *= mult;

    const baseEstimatedHours = Math.max(MIN_HOURS, roundUpToHalf(rawHours || 0));
    const teamApplied = baseEstimatedHours > TEAM_THRESHOLD_HOURS;
    const effectiveHoursUnrounded = teamApplied ? baseEstimatedHours / TEAM_FACTOR : baseEstimatedHours;
    const effectiveHours = Math.max(MIN_HOURS, roundUpToHalf(effectiveHoursUnrounded));

    const addOnsTotal = (form.addOns || []).reduce((sum, key) => {
      const map: Record<string, number> = {
        'Fridge (£20)': 20,
        'Freezer (£20)': 20,
        'Oven (£40)': 40,
        'Ironing (£30)': 30,
        'Blind cleaning (£20)': 20,
        'Kitchen cupboards (each)': 0, // price handled manually per-cupboard if desired
      };
      return sum + (map[key] ?? 0);
    }, 0);

    const suppliesFee = form.products === 'bring' ? SUPPLIES_FEE : 0;
    const labour = effectiveHours * HOURLY_RATE;
    const totalPrice = Math.round((labour + addOnsTotal + suppliesFee) * 100) / 100;

    return { estimatedHours: effectiveHours, baseEstimatedHours, teamApplied, addOnsTotal, suppliesFee, labour, totalPrice };
  }, [form]);

  // compute blocked days (unchanged logic)
  useEffect(() => {
    async function computeBlockedDays() {
      try {
        const staffSnap = await getDocs(collection(db, 'staff'));
        const staff = staffSnap.docs.map(d => d.data()).filter(s => (s as any).active !== false);

        const blocked = new Set<string>();
        const today0 = new Date();
        today0.setHours(0,0,0,0);

        const globalMinNotice =
          staff.length > 0
            ? Math.min(...staff.map((s: Record<string, unknown>) => Number(s['minNoticeHours'] ?? 12)))
            : 12;

        for (let i = -30; i < 60; i++) {
          const dt = new Date();
          dt.setDate(today0.getDate() + i);
          dt.setHours(0,0,0,0);
          const key = ymd(dt);
          const weekday = dt.toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();

          if (dt < today0) { blocked.add(key); continue; }

          const staffAvailableToday = staff.some((s: Record<string, unknown>) => {
            const av = getDayAvail(s?.availability, weekday);
            return av?.available === true;
          });
          if (!staffAvailableToday) { blocked.add(key); continue; }

          const cutoff = new Date(Date.now() + globalMinNotice * 3600_000);
          const endOfDay = new Date(dt); endOfDay.setHours(20,0,0,0);
          if (endOfDay < cutoff) { blocked.add(key); continue; }
        }

        setBlockedDates(blocked);
      } catch (e) {
        console.warn('Blocked days compute failed', e);
        setBlockedDates(new Set());
      }
    }
    computeBlockedDays();
  }, []);

  // load available times for selectedDate (unchanged)
  useEffect(() => {
    async function loadTimes() {
      setSelectedTime('');
      setTimesLoading(true);
      try {
        if (!selectedDate) { setAvailableTimes([]); return; }
        const key = ymd(selectedDate);

        if (blockedDates.has(key)) { setAvailableTimes([]); return; }

        const ref = doc(db, 'unavailability', key);
        const snap = await getDoc(ref);
        const bookedLegacy = new Set<string>();
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown>;
          const booked = data['bookedTimeSlots'] as Record<string, unknown> | undefined;
          if (booked && typeof booked === 'object') {
            for (const t of Object.keys(booked)) {
              if (Boolean(booked[t])) bookedLegacy.add(t);
            }
          } else {
            for (let h = 7; h <= 20; h++) {
              const k = `${h}:00`;
              if (Boolean((data as Record<string, unknown>)[k])) bookedLegacy.add(k);
            }
          }
        }

        const bookingsSnap = await getDocs(query(collection(db, 'bookings'), where('date','==',key)));
        const bookings = bookingsSnap.docs.map(d => d.data() as Record<string, unknown>);

        const staffSnap = await getDocs(collection(db, 'staff'));
        const staff = staffSnap.docs.map(d => d.data() as Record<string, unknown>).filter((s: Record<string, unknown>) => s['active'] !== false);

        const weekday = selectedDate.toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
        const dayStaff = staff.filter((s: Record<string, unknown>) => {
          const av = getDayAvail((s as Record<string, unknown>)['availability'], weekday);
          return av?.available === true;
        });

        if (dayStaff.length === 0) { setAvailableTimes([]); return; }

        const minNotice = Math.min(...dayStaff.map((s: Record<string, unknown>) => {
          const v = Number((s as Record<string, unknown>)['minNoticeHours']);
          return Number.isFinite(v) ? v : 12;
        }));
        const noticeCutoff = new Date(Date.now() + minNotice * 3600_000);

        const candidate = ALL_TIMES.map(h => `${h}:00`).filter(k => !bookedLegacy.has(k));
        const refined: string[] = [];

        for (const k of candidate) {
          const [hh] = k.split(':');
          const slotDt = new Date(selectedDate); slotDt.setHours(parseInt(hh,10),0,0,0);
          if (slotDt < noticeCutoff) continue;
          const slotMins = timeToMinutes(k);
          let atLeastOne = false;

          for (const s of dayStaff) {
            const av = getDayAvail((s as Record<string, unknown>)['availability'], weekday);
            if (!av || !av.available) continue;
            const startM = timeToMinutes(av.start);
            const endM = timeToMinutes(av.end);
            if (!within(slotMins, startM, endM)) continue;
            const buffer = Number((s as Record<string, unknown>)['travelBufferMins'] ?? 30);
            const collides = bookings.some((b: Record<string, unknown>) => {
              if (!b['startTime'] || !b['endTime']) return false;
              const bs = timeToMinutes(b['startTime'] as string); const be = timeToMinutes(b['endTime'] as string);
              const bsExp = Math.max(0, bs - buffer); const beExp = be + buffer;
              return within(slotMins, bsExp, beExp);
            });
            if (!collides) { atLeastOne = true; break; }
          }

          if (atLeastOne) refined.push(k.split(':')[0]);
        }

        setAvailableTimes(refined);
      } catch (e) {
        console.error('Failed to load timeslots:', e);
        setAvailableTimes([]);
      } finally {
        setTimesLoading(false);
      }
    }
    loadTimes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, blockedDates]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDate || !selectedTime) { alert('Please select date and time.'); return; }
    if (!form.customerName || !form.customerEmail || !form.customerPhone) { alert('Please fill name, email, and phone.'); return; }

    const orderId = createOrderId();
    const bookingDate = ymd(selectedDate);
    const bookingTime = `${selectedTime}:00`;
    const submittedAt = new Date().toISOString();

    const zapPayload = {
      customerName: form.customerName, customerEmail: form.customerEmail, customerPhone: form.customerPhone,
      bookingDate, bookingTime, orderId, serviceType: form.serviceType,
      quoteAmount: pricing.totalPrice, quoteAmountInPence: Math.round(pricing.totalPrice * 100),
      quoteDate: bookingDate, submittedAt,
      bedrooms: form.bedrooms, livingRooms: form.livingRooms, kitchens: form.kitchens,
      bathrooms: form.bathrooms, cleanliness: form.cleanliness, additionalRooms: form.additionalRooms,
      addOns: form.addOns, estimatedHours: pricing.estimatedHours, totalPrice: pricing.totalPrice,
      additionalInfo: form.additionalInfo, utilityRooms: form.utilityRooms, products: form.products,
      twoCleaners: pricing.teamApplied, baseEstimatedHours: pricing.baseEstimatedHours,
    };

    const endTime = addHoursToTime(bookingTime, zapPayload.estimatedHours ?? 1);

    // Post to Zapier only if ZapUrl configured (compile-safe)
    if (typeof ZapUrl === 'string' && ZapUrl.length > 10) {
      try {
        await fetch(ZapUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(zapPayload) });
      } catch (err) {
        console.warn('Zapier post failed', err);
      }
    }

    await setDoc(doc(db, 'bookings', orderId), {
      ...zapPayload,
      address: { line1: form.addressLine1, line2: form.addressLine2, town: form.town, county: form.county, postcode: form.postcode },
      date: bookingDate, startTime: bookingTime, endTime, labourRate: HOURLY_RATE, suppliesFee: pricing.suppliesFee,
      addOnsTotal: pricing.addOnsTotal, labourCharge: pricing.labour, status: 'confirmed',
    });

    alert('Booking submitted!');
  }

  // styling helpers
  const input = 'w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#0071bc]/25 focus:border-[#0071bc]';
  const select = input;
  const checkbox = 'h-4 w-4 rounded border-gray-300';
  const sectionTitle = 'text-sm font-semibold text-[#0071bc] mb-4 pb-3 border-b border-gray-200';
  const smallMuted = 'text-xs text-gray-600';

  // page-resize postMessage (unchanged)
  useEffect(() => {
    function postHeight() {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      parent.postMessage({ type: 'resize', height: h }, '*');
    }
    postHeight();
    window.addEventListener('resize', postHeight);
    new ResizeObserver(postHeight).observe(document.body);
    return () => {
      window.removeEventListener('resize', postHeight);
    };
  }, []);

  useEffect(() => {
    const sendHeight = () => {
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      window.parent?.postMessage({ type: 'LUXEN_IFRAME_HEIGHT', height: h }, '*');
    };
    sendHeight();
    const ro = new ResizeObserver(sendHeight);
    ro.observe(document.documentElement);
    window.addEventListener('load', sendHeight);
    window.addEventListener('resize', sendHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener('load', sendHeight);
      window.removeEventListener('resize', sendHeight);
    };
  }, []);

  // helpers to render the sliding section content
  const StepContent = () => {
    const key = STEPS[step];

    if (key === 'address') {
      return (
        <div key={key} className="animate-slide-in">
          <div className={sectionTitle}>Address</div>
          <div className="mt-2 grid grid-cols-1 gap-3">
            <input className={input} name="addressLine1" placeholder="Address line 1" value={form.addressLine1} onChange={onChange} />
            <input className={input} name="addressLine2" placeholder="Address line 2" value={form.addressLine2} onChange={onChange} />
            <input className={input} name="town" placeholder="Town/City" value={form.town} onChange={onChange} />
            <input className={input} name="county" placeholder="County" value={form.county} onChange={onChange} />
            <input className={input} name="postcode" placeholder="Postcode" value={form.postcode} onChange={onChange} />
          </div>
        </div>
      );
    }

    if (key === 'access') {
      return (
        <div key={key} className="animate-slide-in">
          <div className={sectionTitle}>Property Access</div>
          <div className="grid grid-cols-1 gap-4 mb-4">
            <div className="fs-field">
              <label className="fs-label block text-gray-700 mb-1" htmlFor="access">How will we access the property?</label>
              <select
                className="fs-select w-full p-2 rounded-lg"
                id="access" name="access" value={form.access || ''} onChange={onChange} required
                style={{ border: '1px solid #e6e6e6', fontWeight: 400, outline: 'none' }}
              >
                <option value="" disabled>Select access method</option>
                <option value="home">I will be home</option>
                <option value="key">Key will be left in a location</option>
              </select>
            </div>

            {form.access === "key" && (
              <div className="fs-field">
                <label className="text-gray-700 fs-label block text-gray-700 mb-1" htmlFor="keyLocation">Please specify where the key will be located</label>
                <input className="fs-input w-full p-2 border rounded-lg" type="text" id="keyLocation" name="keyLocation" value={form.keyLocation || ''} onChange={onChange} placeholder="e.g., Under the plant pot, with neighbor, etc." required />
              </div>
            )}
          </div>
        </div>
      );
    }

    if (key === 'property') {
      return (
        <div key={key} className="animate-slide-in">
          <div className={sectionTitle}>Property Details</div>
          <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
            <select className={select} name="bedrooms" value={form.bedrooms} onChange={onChange} required>
              <option value="">How many bedrooms?</option>
              {[...Array(10)].map((_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <select className={select} name="livingRooms" value={form.livingRooms} onChange={onChange} required>
              <option value="">How many living rooms?</option>
              {[...Array(6)].map((_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <select className={select} name="kitchens" value={form.kitchens} onChange={onChange} required>
              <option value="">How many kitchens?</option>
              {[...Array(5)].map((_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <select className={select} name="bathrooms" value={form.bathrooms} onChange={onChange} required>
              <option value="">How many bathrooms/toilets?</option>
              {[...Array(8)].map((_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <select className={select} name="utilityRooms" value={form.utilityRooms} onChange={onChange} required>
              <option value="">How many utility rooms?</option>
              {[...Array(5)].map((_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
            <select className={select} name="cleanliness" value={form.cleanliness} onChange={onChange} required>
              <option value="">How dirty is the property?</option>
              <option value="quite-clean">Quite clean</option>
              <option value="average">Average</option>
              <option value="quite-dirty">Quite dirty</option>
              <option value="filthy">Filthy</option>
            </select>
          </div>
        </div>
      );
    }

    if (key === 'additionalRooms') {
      return (
        <div key={key} className="animate-slide-in">
          <div className={sectionTitle}>Additional Rooms</div>
          <div className="fs-checkbox-group mb-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {['Garage', 'Conservatory', 'Dining room'].map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm text-gray-800">
                  <input type="checkbox" className={checkbox} name="additionalRooms" value={r} onChange={onChange} />
                  {r} <span className="text-xs text-gray-500">(adds 0.5h)</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      );
    }

    // addOns
    return (
      <div key="addOns" className="animate-slide-in">
        <div className={sectionTitle}>Add-on Services</div>
        <div className="fs-checkbox-group mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              'Fridge (£20)',
              'Freezer (£20)',
              'Oven (£40)',
              'Ironing (£30)',
              'Blind cleaning (£20)',
              'Kitchen cupboards (each)',
            ].map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm text-gray-800">
                <input type="checkbox" className={checkbox} name="addOns" value={t} onChange={onChange} />
                <span>{t}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Cleaning Products (kept with add-ons step so user decides supplies at the end) */}
        <div className="mt-6">
          <label className="mb-1 block text-xs font-medium text-gray-700">Cleaning Products</label>
          <select className={select} name="products" value={form.products} onChange={onChange}>
            <option value="">Select option</option>
            <option value="bring">Bring our products (+{money.format(SUPPLIES_FEE)})</option>
            <option value="customer">Use my products</option>
          </select>
        </div>
      </div>
    );
  };

  // layout: make embed full-bleed and fill viewport proportionally while preserving proportions
  return (
    <div>
      <style jsx global>{`
        /* Make the embed fill the iframe / section area: full width and full viewport height */
        html, body, #__next { height: 100%; }
        body { margin: 0; background: transparent; }

        /* container now fills the iframe area — min-height 100vh so it fills */
        .container {
          width: 100vw !important;
          max-width: none !important;
          min-height: 100vh !important;
          padding: 2rem !important;
          box-sizing: border-box;
          font-size: 15px;
          display: flex;
          align-items: stretch;
          justify-content: center;
          background: transparent;
        }

        /* wrapper for the two panels - make it expand and preserve proportions */
        .forms-row {
          display: flex !important;
          flex-direction: row;
          gap: 1.5rem !important;
          align-items: stretch !important;
          width: 100%;
          max-width: 1600px;
        }

        /* Desktop / tablet layout (>=900px): side-by-side and stretch to fill height
           Slightly narrow calendar, widen form as requested */
        @media (min-width: 900px) {
          .calendar-container {
            order: 0 !important;
            flex: 0 0 32% !important;   /* was 38% */
            max-width: 32% !important;
            min-width: 340px !important;
            height: auto;
            display: flex;
            flex-direction: column;
            align-self: stretch;
          }
          .form-container {
            order: 0 !important;
            flex: 1 0 68% !important;   /* was 62% */
            max-width: 68% !important;
            min-width: 560px !important;
            display: flex;
            flex-direction: column;
            align-self: stretch;
          }

          /* make the inner form fill the vertical space and scroll when needed */
          .fs-form { display: flex; flex-direction: column; min-height: 100%; }
          .fs-button-group { margin-top: 1rem; }
        }

        /* Mobile / narrow layout (<900px): STACK with calendar first */
        @media (max-width: 899px) {
          .forms-row { flex-direction: column !important; align-items: stretch; }
          .calendar-container { order: 0 !important; width: 100% !important; max-width: 100% !important; }
          .form-container { order: 1 !important; width: 100% !important; max-width: 100% !important; }
          .container { padding: 1rem !important; }
        }

        /* Keep calendar date tiles near-square and prevent squashing */
        .date-cell { aspect-ratio: 1 / 1; min-width: 44px !important; min-height: 44px !important; display: inline-flex; align-items: center; justify-content: center; }

        /* Make calendar grid rows stable */
        .calendar-container .grid.grid-cols-7 { grid-auto-rows: minmax(44px, 1fr); }

        /* Time slots single-line and compact */
        .time-slots-grid button { white-space: nowrap; font-size: 12px; line-height: 1; padding-top: 0.45rem; padding-bottom: 0.45rem; overflow: hidden; text-overflow: ellipsis; }

        /* Transparent panels (keep inputs white) */
        .calendar-container, .form-container { background: transparent !important; }
        .fs-form, .time-slot-container { background: transparent !important; }
        input, select, textarea { background: #fff !important; }

        /* Buttons in calendar */
        .calendar-container button { background: ${UNAVAILABLE_BG} !important; color: ${PRIMARY} !important; font-weight: 500 !important; height: 36px !important; }
        .calendar-container .text-sm { font-weight: 500 !important; }

        /* Preserve subtle shadows for panels */
        .calendar-container.rounded-lg, .fs-form.rounded-lg { box-shadow: 0 1px 4px rgba(0,0,0,0.06); background-clip: padding-box; }

        /* Slightly larger tiles on big screens */
        @media (min-width: 1200px) {
          .container { padding: 3rem !important; }
          .date-cell { min-width: 52px !important; min-height: 52px !important; }
        }

        /* Slide-in (fade + move left->right) for changing sections */
        @keyframes slideInSoft {
          from { opacity: 0; transform: translateX(22px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slideInSoft .28s ease forwards;
          will-change: opacity, transform;
        }

        /* Price card visual separation while keeping design language */
        .price-card {
          border: 1px solid #e5e7eb;
          background: #fafafa;
        }
        .price-row { display:flex; justify-content: space-between; gap:.75rem; padding:.4rem 0; }
        .price-row + .price-row { border-top: 1px dashed #e5e7eb; }
        .price-total { border-top: 1px solid #e5e7eb; margin-top:.5rem; padding-top:.6rem; }
      `}</style>

      <div className="container">
        <div className="forms-row">
          {/* Calendar Container */}
          <aside className="calendar-container self-start w-full md:w-4/12 bg-white rounded-lg shadow-md p-5">
            <div>
              {/* Calendar header */}
              <div className="mb-3 flex items-center justify-between">
                <button
                  className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90"
                  style={{ backgroundColor: UNAVAILABLE_BG, color: PRIMARY }}
                  onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
                  disabled={ymd(viewMonth) === ymd(startMonth)}
                >
                  &lt; Prev
                </button>

                <div className="text-sm" style={{ color: PRIMARY, fontWeight: 400 }}>
                  {monthNames[viewMonth.getMonth()]} {viewMonth.getFullYear()}
                </div>

                <button
                  className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90"
                  style={{ backgroundColor: UNAVAILABLE_BG, color: PRIMARY }}
                  onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
                  disabled={viewMonth.getFullYear() === maxMonth.getFullYear() && viewMonth.getMonth() === maxMonth.getMonth()}
                >
                  Next &gt;
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium" style={{ color: PRIMARY }}>
                {weekdays.map((w) => <div key={w} className="py-1">{w}</div>)}
              </div>

              <div className="mt-2 grid grid-cols-7 gap-2">
                {grid.map((cell, i) => {
                  const isSelected = cell.date && selectedDate && ymd(cell.date) === ymd(selectedDate);
                  const isBeforeToday = cell.date ? (new Date(cell.date.getFullYear(), cell.date.getMonth(), cell.date.getDate()) < now) : false;
                  const isBlocked = cell.date ? blockedDates.has(ymd(cell.date)) || isBeforeToday : false;
                  const base = 'h-10 w-full rounded-md border text-[12px] flex items-center justify-center';
                  const inactive = cell.muted ? ' border-gray-100 text-gray-300 bg-gray-50' : '';
                  let styles: React.CSSProperties = {};
                  let extraCls = ' cursor-pointer hover:opacity-90 text-white';

                  if (cell.muted) { styles = {}; extraCls = ''; }
                  else if (isBlocked) { styles = { backgroundColor: UNAVAILABLE_BG, borderColor: UNAVAILABLE_BG }; extraCls = ' text-gray-400 cursor-not-allowed'; }
                  else if (isSelected) { styles = { backgroundColor: PRIMARY, borderColor: PRIMARY }; }
                  else { styles = { backgroundColor: DATE_BG, borderColor: DATE_BG }; }

                  return (
                    <div
                      key={i}
                      className={`${base} date-cell${inactive}${extraCls}`}
                      style={styles}
                      onClick={() => { if (cell.date && !isBlocked) setSelectedDate(cell.date!); }}
                    >
                      {cell.d || ''}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="time-slot-container mt-5 rounded-lg shadow-sm p-4 inline-block w-full">
              {!selectedDate ? (
                <div className="text-xs text-gray-600">Please select a date first</div>
              ) : (
                <>
                  <h2 className="text-lg font-semibold mb-3" style={{ color: PRIMARY }}>Select a Time</h2>

                  {timesLoading ? (
                    <div className="p-3 text-center bg-gray-50 rounded-md">
                      <span className="text-gray-500">Loading...</span>
                    </div>
                  ) : availableTimes.length === 0 ? (
                    <div className="p-3 text-xs text-gray-600 rounded-md bg-gray-50">
                      No times available for this date
                    </div>
                  ) : (
                    <div className="time-slots-grid grid grid-cols-3 gap-2 md:gap-3">
                      {availableTimes.map((t, idx) => {
                        const isSelected = selectedTime === t;
                        return (
                          <button
                            key={t + '-' + idx}
                            type="button"
                            onClick={() => setSelectedTime(t)}
                            className={`p-3 text-center rounded-md text-xs cursor-pointer ${isSelected ? '' : 'hover:opacity-90'}`}
                            style={{
                              border: `1px solid ${isSelected ? PRIMARY : '#e5e7eb'}`,
                              backgroundColor: isSelected ? 'rgba(0,113,188,0.08)' : '#fff',
                              color: isSelected ? PRIMARY : '#111827',
                            }}
                          >
                            {displayHour(t)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>

          {/* Form Container */}
          <section className="form-container w-full md:w-8/12 self-start">
            <form className="fs-form bg-white rounded-lg shadow-md p-6" onSubmit={onSubmit}>
              {/* Selected Date Display */}
              <div className="fs-field mb-4">
                <div className="selected-date" style={{ color: PRIMARY }}>{displayDate(selectedDate)}</div>
              </div>

              {/* Personal Information (ALWAYS VISIBLE at top) */}
              <div>
                <div className={sectionTitle}>Personal Information</div>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <input className={input} name="customerName" placeholder="Name" value={form.customerName} onChange={onChange} required />
                  <input className={input} name="customerEmail" type="email" placeholder="Email" value={form.customerEmail} onChange={onChange} required />
                  <input className={`${input} md:col-span-2`} name="customerPhone" placeholder="Phone Number" value={form.customerPhone} onChange={onChange} required />
                </div>
              </div>

              {/* SLIDING SECTION AREA (one step at a time) */}
              <div className="mt-6">
                <StepContent />
              </div>

              {/* Navigation buttons ABOVE price breakdown */}
              <div className="fs-button-group mt-6 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={prevStep}
                  disabled={step === 0}
                  className="rounded-md border px-4 py-2 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                >
                  Back
                </button>
                <div className="flex-1" />
                {step < STEPS.length - 1 ? (
                  <button
                    type="button"
                    onClick={nextStep}
                    className="fs-button bg-[#0071bc] text-white font-medium py-2.5 px-5 rounded-lg hover:opacity-90 transition duration-200"
                    style={{ backgroundColor: PRIMARY }}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="fs-button bg-[#0071bc] text-white font-medium py-2.5 px-5 rounded-lg hover:opacity-90 transition duration-200"
                    style={{ backgroundColor: PRIMARY }}
                  >
                    Book Now — {money.format(pricing.totalPrice)}
                  </button>
                )}
              </div>

              {/* Price breakdown (cleaner look, visually separated) */}
              <div className="fs-price-breakdown price-card p-4 rounded-lg mt-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold" style={{ color: PRIMARY }}>Price Breakdown</div>
                  {pricing.teamApplied && (
                    <div className="text-[11px] rounded-md border px-2 py-1" style={{ backgroundColor: '#eef6ff', borderColor: '#dbeafe', color: PRIMARY }}>
                      Two cleaners
                    </div>
                  )}
                </div>
                <div className="price-row">
                  <span>Estimated time</span>
                  <span>{pricing.estimatedHours} h</span>
                </div>
                <div className="price-row">
                  <span>Labour (@ {money.format(HOURLY_RATE)}/h)</span>
                  <span>{money.format(pricing.labour)}</span>
                </div>
                <div className="price-row">
                  <span>Add-ons</span>
                  <span>{money.format(pricing.addOnsTotal)}</span>
                </div>
                <div className="price-row">
                  <span>Supplies</span>
                  <span>{money.format(pricing.suppliesFee)}</span>
                </div>
                <div className="price-row price-total font-semibold">
                  <span>Total</span>
                  <span>{money.format(pricing.totalPrice)}</span>
                </div>
                {/* small context under card */}
                <div className="mt-2 text-[11px] text-gray-500">
                  Final price confirmed after walkthrough. No payment taken here.
                </div>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
