// src/app/office-clean/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import { collection, getDoc, doc, setDoc, getDocs, query, where } from 'firebase/firestore';

// ========= Shared availability helpers (same as home-clean) =========
type AnyAvail = { available?: boolean; startTime?: string; endTime?: string; from?: string; to?: string } | undefined | null;
const titleCaseDay = (lower: string) => lower.charAt(0).toUpperCase() + lower.slice(1);
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

// ----------- UI constants -----------
const PRIMARY = '#0071bc';
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

// ================= PRICING (Office) =================
const HOURLY_RATE = 28;
const MIN_HOURS = 2;
const SUPPLIES_FEE = 5;
const TEAM_THRESHOLD_HOURS = 6;
const TEAM_FACTOR = 1.7;
function roundUpToHalf(x: number) { return Math.ceil(x * 2) / 2; }

// Room types & size weights
type SizeId = 's'|'m'|'l'|'xl';
type RoomTypeId = 'open-plan'|'meeting'|'private-office'|'reception'|'corridor'|'storage';

const SIZE_OPTIONS: { id: SizeId; label: string; hint: string; weight: number }[] = [
  { id: 's',  label: 'Small',  hint: 'up to ~4×4 m (≈16 m²)',   weight: 0.5 },
  { id: 'm',  label: 'Medium', hint: 'around ~6×6 m (≈36 m²)',  weight: 0.8 },
  { id: 'l',  label: 'Large',  hint: 'around ~8×8 m (≈64 m²)',  weight: 1.1 },
  { id: 'xl', label: 'XL',     hint: 'up to ~10×10 m (≈100 m²)',weight: 1.6 },
];

const ROOM_TYPES: { id: RoomTypeId; label: string; multiplier: number }[] = [
  { id: 'open-plan',     label: 'Open-plan area',   multiplier: 1.2 },
  { id: 'meeting',       label: 'Meeting room',     multiplier: 1.0 },
  { id: 'private-office',label: 'Private office',   multiplier: 0.8 },
  { id: 'reception',     label: 'Reception',        multiplier: 0.9 },
  { id: 'corridor',      label: 'Corridor',         multiplier: 0.5 },
  { id: 'storage',       label: 'Storage / Copy',   multiplier: 0.6 },
];

const CLEAN_MULTIPLIER: Record<string, number> = {
  'quite-clean': 0.9,
  'average': 1.0,
  'quite-dirty': 1.25,
  'filthy': 1.6,
};

const PER_CUBICLE_HOURS = 0.35; // per cubicle
const KITCHEN_SIZE_WEIGHT: Record<SizeId, number> = { s: 0.5, m: 0.8, l: 1.1, xl: 1.6 };

const ADDON_PRICES = {
  fridge: 20,
  freezer: 25,
  dishwasher: 10,
  cupboards: 0,
};

// time helpers
const timeToMinutes = (t: string) => {
  const [hh, mm='0'] = t.split(':'); return parseInt(hh,10)*60 + parseInt(mm,10);
};
const within = (x: number, a: number, b: number) => x >= a && x < b;

type OfficeRoom = { typeId: RoomTypeId | ''; sizeId: SizeId | '' };

export default function Page() {
  // date range for calendar
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

  // stepper (simple like your profile flow)
  const [step, setStep] = useState<number>(0);

  // main form details (CONTACT INFO — always visible)
  const [form, setForm] = useState({
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    cleanliness: '',
    products: '',
    additionalInfo: '',
    addressLine1: '',
    addressLine2: '',
    town: '',
    county: '',
    postcode: '',
    serviceType: 'Office Cleaning',
    access: '',
    keyLocation: '',
  });

  // office-specific structured inputs
  const [roomsCount, setRoomsCount] = useState<number>(0);
  const [rooms, setRooms] = useState<OfficeRoom[]>([]);
  const [kitchensCount, setKitchensCount] = useState<number>(0);
  const [kitchenSizeId, setKitchenSizeId] = useState<SizeId | ''>('');
  const [toiletRoomsCount, setToiletRoomsCount] = useState<number>(0);
  const [avgCubicles, setAvgCubicles] = useState<number>(1);
  const [extras, setExtras] = useState<{ fridge: number; freezer: number; dishwasher: number; cupboards: number }>({
    fridge: 0,
    freezer: 0,
    dishwasher: 0,
    cupboards: 0,
  });

  // sizing & iframe behaviour (kept as-is)
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
    const t = setInterval(sendHeight, 800);
    return () => {
      ro.disconnect();
      window.removeEventListener('load', sendHeight);
      window.removeEventListener('resize', sendHeight);
      clearInterval(t);
    };
  }, []);

  // grid calendar
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

  // ensure rooms array length matches roomsCount
  useEffect(() => {
    setRooms(prev => {
      const next = [...prev];
      if (roomsCount > next.length) {
        for (let i = next.length; i < roomsCount; i++) next.push({ typeId: '', sizeId: '' });
      } else if (roomsCount < next.length) {
        next.splice(roomsCount);
      }
      return next;
    });
  }, [roomsCount]);

  // compute blocked days
  useEffect(() => {
    async function computeBlockedDays() {
      try {
        const staffSnap = await getDocs(collection(db, 'staff'));
        const staff = staffSnap.docs.map(d => d.data()).filter(s => s.active !== false);

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
      } catch {
        setBlockedDates(new Set());
      }
    }
    computeBlockedDays();
  }, []);

  // load available times for selectedDate
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
  }, [selectedDate, blockedDates]);

  // ======== Pricing ========
  const pricing = useMemo(() => {
    let roomHours = 0;
    for (const r of rooms) {
      const sizeW = SIZE_OPTIONS.find(s => s.id === r.sizeId)?.weight ?? 0;
      const typeM = ROOM_TYPES.find(t => t.id === r.typeId)?.multiplier ?? 0;
      roomHours += sizeW * typeM;
    }
    const kitchenW = kitchenSizeId ? KITCHEN_SIZE_WEIGHT[kitchenSizeId] : 0;
    const kitchensHours = kitchensCount * kitchenW;

    const totalCubicles = toiletRoomsCount * Math.max(1, avgCubicles);
    const toiletsHours = totalCubicles * PER_CUBICLE_HOURS;

    let raw = roomHours + kitchensHours + toiletsHours;
    const mult = form.cleanliness ? (CLEAN_MULTIPLIER[form.cleanliness] ?? 1) : 1;
    raw *= mult;

    const baseEstimatedHours = Math.max(MIN_HOURS, roundUpToHalf(raw || 0));
    const teamApplied = baseEstimatedHours > TEAM_THRESHOLD_HOURS;
    const effectiveUnrounded = teamApplied ? baseEstimatedHours / TEAM_FACTOR : baseEstimatedHours;
    const estimatedHours = Math.max(MIN_HOURS, roundUpToHalf(effectiveUnrounded));

    const addOnsTotal =
      (extras.fridge ?? 0) * ADDON_PRICES.fridge +
      (extras.freezer ?? 0) * ADDON_PRICES.freezer +
      (extras.dishwasher ?? 0) * ADDON_PRICES.dishwasher +
      (extras.cupboards ?? 0) * ADDON_PRICES.cupboards;

    const suppliesFee = form.products === 'bring' ? SUPPLIES_FEE : 0;
    const labour = estimatedHours * HOURLY_RATE;
    const totalPrice = Math.round((labour + addOnsTotal + suppliesFee) * 100) / 100;

    return { estimatedHours, baseEstimatedHours, teamApplied, addOnsTotal, suppliesFee, labour, totalPrice };
  }, [rooms, kitchensCount, kitchenSizeId, toiletRoomsCount, avgCubicles, extras, form.cleanliness, form.products]);

  // submit
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDate || !selectedTime) { alert('Please select date and time.'); return; }
    if (!form.customerName || !form.customerEmail || !form.customerPhone) { alert('Please fill name, email, and phone.'); return; }

    const orderId = createOrderId();
    const bookingDate = ymd(selectedDate);
    const bookingTime = `${selectedTime}:00`;
    const submittedAt = new Date().toISOString();

    const addOnsList: string[] = [];
    if ((extras.fridge ?? 0) > 0) addOnsList.push(`Fridge clean x${extras.fridge}`);
    if ((extras.freezer ?? 0) > 0) addOnsList.push(`Freezer clean x${extras.freezer}`);
    if ((extras.dishwasher ?? 0) > 0) addOnsList.push(`Dishwasher load/unload x${extras.dishwasher}`);
    if ((extras.cupboards ?? 0) > 0) addOnsList.push(`Kitchen cupboards x${extras.cupboards}`);

    const additionalRooms: string[] = rooms.map((r, i) => {
      const rt = ROOM_TYPES.find(t => t.id === r.typeId)?.label ?? 'Room';
      const sz = SIZE_OPTIONS.find(s => s.id === r.sizeId);
      const label = sz ? `${sz.label} (${sz.hint})` : '';
      return `#${i+1} ${rt} — ${label}`;
    });

    const zapPayload = {
      customerName: form.customerName, customerEmail: form.customerEmail, customerPhone: form.customerPhone,
      bookingDate, bookingTime, orderId, serviceType: form.serviceType,
      quoteAmount: pricing.totalPrice, quoteAmountInPence: Math.round(pricing.totalPrice * 100),
      quoteDate: bookingDate, submittedAt,
      bedrooms: '', livingRooms: '', kitchens: String(kitchensCount),
      bathrooms: '', cleanliness: form.cleanliness, additionalRooms,
      addOns: addOnsList, estimatedHours: pricing.estimatedHours, totalPrice: pricing.totalPrice,
      additionalInfo: form.additionalInfo, utilityRooms: '', products: form.products,
      twoCleaners: pricing.teamApplied, baseEstimatedHours: pricing.baseEstimatedHours,
    };

    const endTime = addHoursToTime(bookingTime, zapPayload.estimatedHours ?? 1);



    await setDoc(doc(db, 'bookings', orderId), {
      ...zapPayload,
      address: { line1: form.addressLine1, line2: form.addressLine2, town: form.town, county: form.county, postcode: form.postcode },
      date: bookingDate, startTime: bookingTime, endTime, labourRate: HOURLY_RATE, suppliesFee: pricing.suppliesFee,
      addOnsTotal: pricing.addOnsTotal, labourCharge: pricing.labour, status: 'confirmed',
      office: {
        roomsCount,
        rooms,
        kitchensCount,
        kitchenSizeId,
        toiletRoomsCount,
        avgCubicles,
        extras,
      },
    });

    alert('Booking submitted!');
  }

  // inputs/styles (same tokens as home-clean)
  const input = 'w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#0071bc]/25 focus:border-[#0071bc]';
  const select = input;
  const sectionTitle = 'text-sm font-semibold text-[#0071bc] mb-4 pb-3 border-b border-gray-200';
  const smallMuted = 'text-xs text-gray-600';

  // step guards
  const canNext = useMemo(() => {
    if (step === 0) {
      return roomsCount >= 0 && !!form.cleanliness;
    }
    if (step === 1) {
      if (roomsCount === 0) return true;
      return rooms.every(r => r.typeId && r.sizeId);
    }
    if (step === 2) {
      if (kitchensCount === 0) return true;
      return !!kitchenSizeId;
    }
    if (step === 3) {
      return toiletRoomsCount >= 0 && avgCubicles >= 1;
    }
    if (step === 4) {
      return true;
    }
    if (step === 5) {
      return !!form.access && (form.access !== 'key' || !!form.keyLocation);
    }
    return true;
  }, [step, roomsCount, form.cleanliness, rooms, kitchensCount, kitchenSizeId, toiletRoomsCount, avgCubicles, form.access, form.keyLocation]);

  const goNext = () => { if (canNext) setStep(s => Math.min(5, s + 1)); };
  const goBack = () => setStep(s => Math.max(0, s - 1));

  return (
    <div>
      <style jsx global>{`
        html, body, #__next { height: 100%; }
        body { margin: 0; background: transparent; }
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
        .forms-row {
          display: flex !important;
          flex-direction: row;
          gap: 1.5rem !important;
          align-items: stretch !important;
          width: 100%;
          max-width: 1600px;
        }
        @media (min-width: 900px) {
          .calendar-container {
            order: 0 !important;
            flex: 0 0 38% !important;
            max-width: 38% !important;
            min-width: 360px !important;
            height: auto;
            display: flex;
            flex-direction: column;
            align-self: stretch;
          }
          .form-container {
            order: 0 !important;
            flex: 1 0 62% !important;
            max-width: 62% !important;
            min-width: 540px !important;
            display: flex;
            flex-direction: column;
            align-self: stretch;
          }
          .fs-form { display: flex; flex-direction: column; height: 100%; overflow: visible; }
        }
        @media (max-width: 899px) {
          .forms-row { flex-direction: column !important; align-items: stretch; }
          .calendar-container { order: 0 !important; width: 100% !important; max-width: 100% !important; }
          .form-container { order: 1 !important; width: 100% !important; max-width: 100% !important; }
          .container { padding: 1rem !important; }
        }
        .date-cell { aspect-ratio: 1 / 1; min-width: 44px !important; min-height: 44px !important; display: inline-flex; align-items: center; justify-content: center; }
        .calendar-container .grid.grid-cols-7 { grid-auto-rows: minmax(44px, 1fr); }
        .time-slots-grid button { white-space: nowrap; font-size: 12px; line-height: 1; padding-top: 0.45rem; padding-bottom: 0.45rem; overflow: hidden; text-overflow: ellipsis; }
        .calendar-container { align-self: stretch; }
        .calendar-container, .form-container { background: transparent !important; }
        .fs-form, .time-slot-container { background: transparent !important; }
        input, select, textarea { background: #fff !important; }
        .calendar-container button { background: ${UNAVAILABLE_BG} !important; color: ${PRIMARY} !important; font-weight: 500 !important; height: 36px !important; }
        .calendar-container .text-sm { font-weight: 500 !important; }
        .calendar-container.rounded-lg, .fs-form.rounded-lg { box-shadow: 0 1px 4px rgba(0,0,0,0.06); background-clip: padding-box; }
        @media (min-width: 1200px) {
          .container { padding: 3rem !important; }
          .date-cell { min-width: 52px !important; min-height: 52px !important; }
        }

        /* Simple mount-based animation (like your profile flow feel) */
        @keyframes slideFadeIn {
          from { opacity: 0; transform: translateX(24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .step-anim {
          animation: slideFadeIn 260ms ease forwards;
          will-change: transform, opacity;
        }
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

              {/* CONTACT INFO — always visible at the top */}
              <div>
                <div className={sectionTitle}>Contact</div>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <input
                    className={input}
                    name="customerName"
                    placeholder="Company name or contact name"
                    value={form.customerName}
                    onChange={(e)=>setForm(p=>({ ...p, customerName: e.target.value }))}
                    required
                  />
                  <input
                    className={input}
                    name="customerEmail"
                    type="email"
                    placeholder="Email"
                    value={form.customerEmail}
                    onChange={(e)=>setForm(p=>({ ...p, customerEmail: e.target.value }))}
                    required
                  />
                  <input
                    className={`${input} md:col-span-2`}
                    name="customerPhone"
                    placeholder="Phone Number"
                    value={form.customerPhone}
                    onChange={(e)=>setForm(p=>({ ...p, customerPhone: e.target.value }))}
                    required
                  />
                </div>
              </div>

              {/* SINGLE MOUNTED PANEL — remounts on step change and animates in */}
              <div key={`panel-${step}`} className="step-anim mt-6">
                {step === 0 && (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">How many rooms?</label>
                      <select
                        className={select}
                        value={roomsCount}
                        onChange={(e)=>setRoomsCount(Math.max(0, parseInt(e.target.value||'0',10)))}
                      >
                        {[0,1,2,3,4,5,6,7,8,9,10,12,15,20].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <p className={smallMuted}>Include open-plan, meeting rooms, private offices, corridors, storage, etc.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">Footfall level</label>
                      <select
                        className={select}
                        value={form.cleanliness}
                        onChange={(e)=>setForm(p=>({ ...p, cleanliness: e.target.value }))}
                        required
                      >
                        <option value="">Select</option>
                        <option value="quite-clean">Low</option>
                        <option value="average">Typical</option>
                        <option value="quite-dirty">High</option>
                        <option value="filthy">Very high</option>
                      </select>
                      <p className={smallMuted}>Used to adjust the time estimate.</p>
                    </div>
                  </div>
                )}

                {step === 1 && (
                  roomsCount === 0 ? (
                    <div className="text-sm text-gray-700">No rooms to describe — continue to kitchens.</div>
                  ) : (
                    <div className="space-y-3">
                      {rooms.map((r, idx) => (
                        <div key={idx} className="grid grid-cols-1 md:grid-cols-2 gap-3 border rounded-lg p-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-800 mb-1">Room #{idx+1} — Type</label>
                            <select
                              className={select}
                              value={r.typeId}
                              onChange={(e)=>{
                                const val = e.target.value as RoomTypeId | '';
                                setRooms(prev => prev.map((x,i)=> i===idx ? ({ ...x, typeId: val }) : x));
                              }}
                            >
                              <option value="">Select type</option>
                              {ROOM_TYPES.map(rt => <option key={rt.id} value={rt.id}>{rt.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-800 mb-1">Approx size</label>
                            <select
                              className={select}
                              value={r.sizeId}
                              onChange={(e)=>{
                                const val = e.target.value as SizeId | '';
                                setRooms(prev => prev.map((x,i)=> i===idx ? ({ ...x, sizeId: val }) : x));
                              }}
                            >
                              <option value="">Select</option>
                              {SIZE_OPTIONS.map(s => <option key={s.id} value={s.id}>{`${s.label} – ${s.hint}`}</option>)}
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {step === 2 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">How many kitchens / tea points?</label>
                      <select className={select} value={kitchensCount} onChange={(e)=>setKitchensCount(Math.max(0, parseInt(e.target.value||'0',10)))}>
                        {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">Typical size</label>
                      <select className={select} value={kitchenSizeId} onChange={(e)=>setKitchenSizeId(e.target.value as SizeId | '')} disabled={kitchensCount === 0}>
                        <option value="">Select</option>
                        {SIZE_OPTIONS.map(s => <option key={s.id} value={s.id}>{`${s.label} – ${s.hint}`}</option>)}
                      </select>
                      <p className={smallMuted}>Choose the closest range.</p>
                    </div>
                  </div>
                )}

                {step === 3 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">How many toilet rooms?</label>
                      <select className={select} value={toiletRoomsCount} onChange={(e)=>setToiletRoomsCount(Math.max(0, parseInt(e.target.value||'0',10)))}>
                        {[0,1,2,3,4,5,6,8,10].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-800 mb-1">Average cubicles per toilet</label>
                      <select className={select} value={avgCubicles} onChange={(e)=>setAvgCubicles(Math.max(1, parseInt(e.target.value||'1',10)))}>
                        {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <p className={smallMuted}>We’ll estimate {toiletRoomsCount * Math.max(1, avgCubicles)} cubicles total.</p>
                    </div>
                  </div>
                )}

                {step === 4 && (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[
                        { key: 'fridge',     label: 'Fridge clean',                price: ADDON_PRICES.fridge },
                        { key: 'freezer',    label: 'Freezer clean',               price: ADDON_PRICES.freezer },
                        { key: 'dishwasher', label: 'Dishwasher load/unload',      price: ADDON_PRICES.dishwasher },
                        { key: 'cupboards',  label: 'Kitchen cupboards (count)',   price: ADDON_PRICES.cupboards },
                      ].map(item => (
                        <div key={item.key}>
                          <label className="block text-sm font-medium text-gray-800 mb-1">
                            {item.label} {item.price ? `(+${money.format(item.price)} each)` : ''}
                          </label>
                          <select
                            className={select}
                            value={(extras as any)[item.key] ?? 0}
                            onChange={(e)=>{
                              const val = Math.max(0, parseInt(e.target.value||'0',10));
                              setExtras(prev => ({ ...prev, [item.key]: val }));
                            }}
                          >
                            {[0,1,2,3,4,5,6,8,10].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4">
                      <label className="mb-1 block text-xs font-medium text-gray-700">Supplies</label>
                      <select className={select} name="products" value={form.products} onChange={(e)=>setForm(p=>({ ...p, products: e.target.value }))}>
                        <option value="">Select option</option>
                        <option value="bring">Bring our supplies (+{money.format(SUPPLIES_FEE)})</option>
                        <option value="customer">Use site supplies</option>
                      </select>
                    </div>
                  </>
                )}

                {step === 5 && (
                  <>
                    <div className={sectionTitle}>Site & Access</div>
                    <div className="mt-2 grid grid-cols-1 gap-3">
                      <input className={input} name="addressLine1" placeholder="Address line 1" value={form.addressLine1} onChange={(e)=>setForm(p=>({ ...p, addressLine1: e.target.value }))} />
                      <input className={input} name="addressLine2" placeholder="Address line 2" value={form.addressLine2} onChange={(e)=>setForm(p=>({ ...p, addressLine2: e.target.value }))} />
                      <input className={input} name="town" placeholder="Town/City" value={form.town} onChange={(e)=>setForm(p=>({ ...p, town: e.target.value }))} />
                      <input className={input} name="county" placeholder="County" value={form.county} onChange={(e)=>setForm(p=>({ ...p, county: e.target.value }))} />
                      <input className={input} name="postcode" placeholder="Postcode" value={form.postcode} onChange={(e)=>setForm(p=>({ ...p, postcode: e.target.value }))} />
                    </div>

                    <div className="grid grid-cols-1 gap-4 mt-4">
                      <div className="fs-field">
                        <label className="fs-label block text-gray-700 mb-1" htmlFor="access">How will we access the property?</label>
                        <select
                          className="fs-select w-full p-2 rounded-lg"
                          id="access" name="access" value={form.access || ''} onChange={(e)=>setForm(p=>({ ...p, access: e.target.value }))} required
                          style={{ border: '1px solid #e6e6e6', fontWeight: 400, outline: 'none' }}
                        >
                          <option value="" disabled>Select access method</option>
                          <option value="home">A member of staff will meet you</option>
                          <option value="key">Key will be left in a location</option>
                        </select>
                      </div>

                      {form.access === "key" && (
                        <div className="fs-field">
                          <label className="text-gray-700 fs-label block text-gray-700 mb-1" htmlFor="keyLocation">Please specify where the key will be located</label>
                          <input
                            className="fs-input w-full p-2 border rounded-lg"
                            type="text" id="keyLocation" name="keyLocation"
                            value={form.keyLocation || ''} onChange={(e)=>setForm(p=>({ ...p, keyLocation: e.target.value }))}
                            placeholder="e.g., With reception, lockbox (code), etc."
                            required
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Navigation — ABOVE the price breakdown */}
              <div className="fs-button-group flex items-center justify-between gap-3 mt-6 mb-4">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 0}
                  className="rounded-lg px-4 py-3 border text-sm hover:opacity-90 disabled:opacity-60"
                  style={{ borderColor: '#e5e7eb', color: '#111827', background: '#fff' }}
                >
                  Back
                </button>

                {step < 5 ? (
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={!canNext}
                    className="fs-button bg-[#0071bc] text-white font-medium py-3 px-6 rounded-lg hover:opacity-90 transition duration-200 disabled:opacity-60"
                    style={{ backgroundColor: PRIMARY }}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="fs-button bg-[#0071bc] text-white font-medium py-3 px-6 rounded-lg hover:opacity-90 transition duration-200"
                    style={{ backgroundColor: PRIMARY }}
                  >
                    Book Now — {money.format(pricing.totalPrice)}
                  </button>
                )}
              </div>

              {/* Price breakdown (always below navigation) */}
              <div className="fs-price-breakdown bg-gray-50 p-4 rounded-lg mb-4">
                <div className="font-semibold mb-1">Price Breakdown</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-y-1">
                  <div>Estimated time</div><div className="text-right">{pricing.estimatedHours} h</div>
                  <div>Labour (@ {money.format(HOURLY_RATE)}/h)</div><div className="text-right">{money.format(pricing.labour)}</div>
                  <div>Add-ons</div><div className="text-right">{money.format(pricing.addOnsTotal)}</div>
                  <div>Supplies fee</div><div className="text-right">{money.format(pricing.suppliesFee)}</div>
                  <div className="font-semibold mt-2">Total</div><div className="text-right font-semibold mt-2">{money.format(pricing.totalPrice)}</div>
                </div>
                {pricing.teamApplied && (
                  <div className="mt-3 rounded-md border px-3 py-2 text-xs" style={{ backgroundColor: '#eef6ff', borderColor: '#dbeafe', color: PRIMARY }}>
                    ✓ Two cleaners will be assigned to this booking
                  </div>
                )}
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
