// src/app/office-clean/page.tsx
'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { db } from '@/lib/firebase';
import {
  collection,
  getDoc,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';

import { IframeHeightReporter } from '../IframeHeightReporter';


// ========= Phone normaliser =========
function toE164UK(raw?: string | null): string | null {
  if (!raw) return null;

  const digits = raw.replace(/[^\d]/g, '');

  if (digits.startsWith('0') && digits.length >= 10) {
    return '+44' + digits.slice(1);
  }

  if (digits.startsWith('44')) {
    return '+' + digits;
  }

  if (raw.trim().startsWith('+')) {
    return raw.trim();
  }

  return '+' + digits;
}

// ========= AddressLookup (office copy, with postcode coverage check) =========
type AddressLookupProps = {
  onAddressSelect?: (addr: {
    line1: string;
    line2: string;
    town: string;
    county: string;
    postcode: string;
    fullAddress: string;
  }) => void;
};

function AddressLookup({ onAddressSelect }: AddressLookupProps) {
  const GET_ADDRESS_API_KEY = process.env.NEXT_PUBLIC_GA_API_KEY;

  const [postcode, setPostcode] = useState('');
  const [addresses, setAddresses] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<any | null>(null);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [customAddress, setCustomAddress] = useState({
    line1: '',
    line2: '',
    town: '',
    county: '',
    postcode: '',
  });
  const [notCoveredMsg, setNotCoveredMsg] = useState<string | null>(null);

  const handlePostcodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPostcode(e.target.value.toUpperCase());
    setError('');
  };

  // Extract outward part (e.g. "M1", "M23", "M17") from a full postcode
  const extractOutward = (raw: string): string | null => {
    const compact = raw.replace(/\s+/g, '').toUpperCase();
    if (compact.length < 5) return null;
    return compact.slice(0, compact.length - 3);
  };

  const handleSearch = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();

    if (!postcode.trim()) {
      setError('Please enter a postcode');
      return;
    }

    setLoading(true);
    setError('');
    setAddresses([]);

    try {
      const formattedPostcode = postcode.trim().toUpperCase();
      const outward = extractOutward(formattedPostcode);

      if (!outward) {
        setError('Please enter a valid UK postcode');
        setLoading(false);
        return;
      }

      // Check coverage in Firestore "postcodes" collection
      try {
        const pcRef = doc(db, 'postcodes', outward);
        const pcSnap = await getDoc(pcRef);
        if (!pcSnap.exists()) {
          setNotCoveredMsg(`Sorry, we don't cover ${formattedPostcode} yet.`);
          setLoading(false);
          return;
        }
      } catch (err) {
        console.error('Postcode coverage check failed', err);
        setError('Something went wrong checking coverage. Please try again.');
        setLoading(false);
        return;
      }

      // If covered, proceed with getAddress.io
      const noSpaces = formattedPostcode.replace(/\s+/g, '');
      const response = await fetch(
        `https://api.getaddress.io/find/${noSpaces}?api-key=${GET_ADDRESS_API_KEY}`
      );

      if (!response.ok) {
        if (response.status === 401) {
          setError('API authentication failed. Please check your API key.');
        } else if (response.status === 404) {
          setError('Postcode not found. Please check and try again.');
        } else if (response.status === 429) {
          setError('API usage limit reached. Please try again later.');
        } else {
          setError(`Error: ${response.status} - ${response.statusText}`);
        }
        setAddresses([]);
        setLoading(false);
        return;
      }

      const data = await response.json();

      if (data.addresses && data.addresses.length > 0) {
        setAddresses(
          data.addresses.map((address: string) => {
            const parts = address.split(', ').filter((part) => part.trim());
            return {
              fullAddress: address,
              line1: parts[0] || '',
              line2: parts.length > 2 ? parts[1] : '',
              town:
                parts.length > 2
                  ? parts[parts.length - 2]
                  : parts.length > 1
                  ? parts[1]
                  : '',
              county: parts.length > 1 ? parts[parts.length - 1] : '',
              postcode: data.postcode,
            };
          })
        );
      } else {
        setError('No addresses found for this postcode');
        setAddresses([]);
      }
    } catch (error) {
      console.error('Error fetching addresses:', error);
      setError('Error fetching addresses. Please try again or enter manually.');
    } finally {
      setLoading(false);
    }
  };

  const handleAddressSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedIndex = e.target.value;
    if (selectedIndex === 'manual') {
      setShowAddressForm(true);
      setSelectedAddress(null);
      setCustomAddress((prev) => ({
        ...prev,
        postcode: postcode,
      }));
    } else if (selectedIndex !== '') {
      const selected = addresses[parseInt(selectedIndex, 10)];
      const addressWithPostcode = {
        ...selected,
        postcode: selected.postcode || postcode,
      };
      setSelectedAddress(addressWithPostcode);
      setShowAddressForm(false);
      if (onAddressSelect) {
        onAddressSelect(addressWithPostcode);
      }
    } else {
      setSelectedAddress(null);
    }
  };

  const handleCustomAddressChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, value } = e.target;
    setCustomAddress((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const validateManualAddress = () => {
    if (!customAddress.line1) {
      setError('Address line 1 is required');
      return false;
    }
    if (!customAddress.town) {
      setError('Town/City is required');
      return false;
    }
    if (!customAddress.postcode) {
      setError('Postcode is required');
      return false;
    }
    return true;
  };

  const handleCustomAddressSubmit = () => {
    setError('');
    if (!validateManualAddress()) {
      return;
    }

    const formattedPostcode = customAddress.postcode.toUpperCase().trim();

    const manualAddress = {
      ...customAddress,
      postcode: formattedPostcode,
      fullAddress: `${customAddress.line1}, ${
        customAddress.line2 ? customAddress.line2 + ', ' : ''
      }${customAddress.town}, ${
        customAddress.county ? customAddress.county + ', ' : ''
      }${formattedPostcode}`,
    };

    setSelectedAddress(manualAddress);
    setShowAddressForm(false);

    if (onAddressSelect) {
      onAddressSelect(manualAddress);
    }
  };

  return (
    <div className="address-lookup-container rounded-2xl border border-gray-200 border border-[#e0e6ed]
  rounded-md shadow-[4px_6px_10px_-3px_#bfc9d4] p-4 sm:p-5">      <div className="text-lg font-semibold text-[#0071bc] mb-3 pb-2 border-b border-gray-200">
        Site address
      </div>

      {/* Postcode Search */}
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="fs-field flex-grow">
          <label
            className="fs-label block text-gray-700 mb-1"
            htmlFor="postcode"
          >
            Enter postcode
          </label>
          <input
            className="fs-input w-full p-2 border border-gray-200 rounded-lg"
            type="text"
            id="postcode"
            name="postcode"
            value={postcode}
            onChange={handlePostcodeChange}
            placeholder="e.g. M1 1AA"
          />
        </div>
        <button
          className="fs-button bg-[#0071bc] text-white font-medium py-2 px-4 rounded-lg hover:opacity-95 transition duration-200"
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? 'Searching...' : 'Find address'}
        </button>
      </div>

      {error && <div className="text-red-500 mb-3 text-sm">{error}</div>}

      {addresses.length > 0 && (
        <div className="fs-field mb-3">
          <label
            className="fs-label block text-gray-700 mb-1"
            htmlFor="address-select"
          >
            Select address
          </label>
          <select
            className="fs-select w-full p-2 border border-gray-200 rounded-lg"
            id="address-select"
            onChange={handleAddressSelect}
            defaultValue=""
          >
            <option value="" disabled>
              Choose your address
            </option>
            {addresses.map((address, index) => (
              <option key={index} value={index}>
                {address.fullAddress}
              </option>
            ))}
            <option value="manual">Enter address manually</option>
          </select>
        </div>
      )}

      {showAddressForm && (
        <div className="manual-address-form">
          <div className="grid grid-cols-1 gap-3 mb-3">
            <div className="fs-field">
              <label
                className="fs-label block text-gray-700 mb-1"
                htmlFor="line1"
              >
                Address line 1
              </label>
              <input
                className="fs-input w-full p-2 border rounded-lg"
                type="text"
                id="line1"
                name="line1"
                value={customAddress.line1}
                onChange={handleCustomAddressChange}
                required
              />
            </div>
            <div className="fs-field">
              <label
                className="fs-label block text-gray-700 mb-1"
                htmlFor="line2"
              >
                Address line 2 (optional)
              </label>
              <input
                className="fs-input w-full p-2 border rounded-lg"
                type="text"
                id="line2"
                name="line2"
                value={customAddress.line2}
                onChange={handleCustomAddressChange}
              />
            </div>
            <div className="fs-field">
              <label
                className="fs-label block text-gray-700 mb-1"
                htmlFor="town"
              >
                Town / city
              </label>
              <input
                className="fs-input w-full p-2 border rounded-lg"
                type="text"
                id="town"
                name="town"
                value={customAddress.town}
                onChange={handleCustomAddressChange}
                required
              />
            </div>
            <div className="fs-field">
              <label
                className="fs-label block text-gray-700 mb-1"
                htmlFor="county"
              >
                County
              </label>
              <input
                className="fs-input w-full p-2 border rounded-lg"
                type="text"
                id="county"
                name="county"
                value={customAddress.county}
                onChange={handleCustomAddressChange}
                required
              />
            </div>
            <div className="fs-field">
              <label
                className="fs-label block text-gray-700 mb-1"
                htmlFor="manual-postcode"
              >
                Postcode
              </label>
              <input
                className="fs-input w-full p-2 border rounded-lg"
                type="text"
                id="manual-postcode"
                name="postcode"
                value={customAddress.postcode || postcode}
                onChange={handleCustomAddressChange}
                required
              />
            </div>
          </div>
          <button
            className="fs-button bg-[#0071bc] text-white font-medium py-2 px-4 rounded-lg hover:opacity-95 transition duration-200"
            onClick={handleCustomAddressSubmit}
          >
            Confirm address
          </button>
        </div>
      )}

      {selectedAddress && !showAddressForm && (
        <div className="selected-address bg-gray-50 p-3 rounded-lg mb-3 text-sm">
          <div className="mb-1 font-medium">Selected address:</div>
          <div>{selectedAddress.line1}</div>
          {selectedAddress.line2 && <div>{selectedAddress.line2}</div>}
          <div>{selectedAddress.town}</div>
          {selectedAddress.county && <div>{selectedAddress.county}</div>}
          <div>{selectedAddress.postcode}</div>
          <button
            className="text-[#0071bc] underline mt-2 text-xs"
            onClick={() => {
              setSelectedAddress(null);
              setShowAddressForm(false);
            }}
          >
            Change
          </button>
        </div>
      )}

      {!showAddressForm && addresses.length === 0 && !loading && !error && (
        <div className="text-xs text-gray-600 mt-1">
          You can also enter your address manually after checking coverage.
        </div>
      )}

      {/* Not-covered modal */}
      {notCoveredMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-xl p-5 max-w-sm w-full shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Out of area
            </h3>
            <p className="text-sm text-gray-700 mb-4">{notCoveredMsg}</p>
            <button
              className="bg-[#0071bc] text-white text-sm font-medium px-4 py-2 rounded-md w-full hover:opacity-95"
              onClick={() => setNotCoveredMsg(null)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ========= Shared availability helpers (same as home-clean) =========
type AnyAvail =
  | {
      available?: boolean;
      startTime?: string;
      endTime?: string;
      from?: string;
      to?: string;
    }
  | undefined
  | null;
const titleCaseDay = (lower: string) =>
  lower.charAt(0).toUpperCase() + lower.slice(1);
function getDayAvail(
  availObj: unknown,
  weekdayLower: string
): { available: boolean; start: string; end: string } | null {
  if (!availObj || typeof availObj !== 'object') return null;
  const obj = availObj as Record<string, unknown>;
  const a = (obj[weekdayLower] ?? obj[titleCaseDay(weekdayLower)]) as AnyAvail;
  if (!a || typeof a !== 'object') return null;

  const aRec = a as Record<string, unknown>;
  const available = !!aRec.available;
  const start =
    (aRec.startTime as string | undefined) ||
    (aRec.from as string | undefined) ||
    '07:00';
  const end =
    (aRec.endTime as string | undefined) ||
    (aRec.to as string | undefined) ||
    '20:00';
  return { available, start, end };
}

// ----------- UI constants -----------
const PRIMARY = '#0071bc';
const DATE_BG = '#4caf50';
const UNAVAILABLE_BG = '#f1f1f1';
const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const ALL_TIMES = [
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
];

// --- booking helpers ---
function addHoursToTime(hhmm: string, hoursFloat: number) {
  const [hStr, mStr] = hhmm.split(':');
  let minutes = parseInt(hStr, 10) * 60 + parseInt(mStr || '0', 10);
  minutes += Math.round((hoursFloat || 0) * 60);
  const endH = Math.floor(minutes / 60);
  const endM = minutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
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
const money = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 2,
});

// ================= PRICING (Office – same logic as home) =================
// ================= PRICING =================
const WEEKDAY_HOURLY_RATE = 30;
const WEEKEND_HOURLY_RATE = 32;
const MIN_HOURS = 2;

function isWeekend(date: Date | null): boolean {
  if (!date) return false;
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

const SUPPLIES_FEE = 5;
const TEAM_THRESHOLD_HOURS = 4;
const TEAM_FACTOR = 1.7;
function roundUpToHalf(x: number) {
  return Math.ceil(x * 2) / 2;
}

// Room types & size weights
type SizeIdLocal = 'xs' | 's' | 'm' | 'l' | 'xl';
type RoomTypeId =
  | 'open-plan'
  | 'meeting'
  | 'private-office'
  | 'reception'
  | 'corridor'
  | 'storage'
  | 'kitchen'
  | 'bathroom';

const SIZE_OPTIONS: {
  id: SizeIdLocal;
  label: string;
  hint: string;
  weight: number;
}[] = [
  { id: 'xs', label: 'Extra small', hint: 'up to ~2×2 m (≈4 m²)', weight: 0.3 },
  { id: 's', label: 'Small', hint: 'up to ~4×4 m (≈16 m²)', weight: 0.5 },
  { id: 'm', label: 'Medium', hint: 'around ~6×6 m (≈36 m²)', weight: 0.8 },
  { id: 'l', label: 'Large', hint: 'around ~8×8 m (≈64 m²)', weight: 1.1 },
  { id: 'xl', label: 'XL', hint: 'up to ~10×10 m (≈100 m²)', weight: 1.6 },
];

const ROOM_TYPES: { id: RoomTypeId; label: string; multiplier: number }[] = [
  { id: 'open-plan', label: 'Open-plan area', multiplier: 1.4 },
  { id: 'meeting', label: 'Meeting room', multiplier: 1.2 },
  { id: 'private-office', label: 'Private office', multiplier: 1.0 },
  { id: 'reception', label: 'Reception', multiplier: 1.1 },
  { id: 'corridor', label: 'Corridor', multiplier: 0.7 },
  { id: 'storage', label: 'Storage / copy room', multiplier: 0.8 },
  { id: 'kitchen', label: 'Kitchen / tea point', multiplier: 1.3 },
  { id: 'bathroom', label: 'Toilet room', multiplier: 1.2 },
];

const CLEAN_MULTIPLIER: Record<string, number> = {
  'quite-clean': 0.9,
  average: 1.0,
  'quite-dirty': 1.25,
  filthy: 1.6,
};

const CLEAN_LABELS: Record<string, string> = {
  'quite-clean': 'Low footfall',
  average: 'Typical footfall',
  'quite-dirty': 'High footfall',
  filthy: 'Very high footfall',
};

const PER_CUBICLE_HOURS = 0.35; // per cubicle

const ADDON_PRICES = {
  fridge: 20,
  freezer: 25,
  dishwasher: 10,
  cupboards: 0,
};

const ADDON_HOURS = {
  fridge: 0.5,
  freezer: 0.75,
  dishwasher: 0.25,
  cupboards: 0.25,
};

// time helpers
const timeToMinutes = (t: string) => {
  const [hh, mm = '0'] = t.split(':');
  return parseInt(hh, 10) * 60 + parseInt(mm, 10);
};
const within = (x: number, a: number, b: number) => x >= a && x < b;

type OfficeRoom = { typeId: RoomTypeId | ''; sizeId: SizeIdLocal | '' };

type ExtrasSummary = {
  fridge: number;
  freezer: number;
  dishwasher: number;
  cupboards: number;
};

type RoomSummary = {
  typeId: RoomTypeId | 'kitchen' | 'bathroom';
  label: string;
  count: number;
  sizes: (SizeIdLocal | '')[];
};

type BookingSummaryState = {
  orderId: string;
  bookingDate: string;
  bookingTime: string;
  bookingDisplayDate: string;
  bookingDisplayTime: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: {
    line1: string;
    line2: string;
    town: string;
    county: string;
    postcode: string;
  };
  totalPrice: number;
  estimatedHours: number;
};

type AllRoomsSummaryItem = {
  typeId: string;
  label: string;
  count: number;
  sizes: (SizeIdLocal | '')[];
};

// initial states
const initialFormState = {
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
};

const initialExtras: ExtrasSummary = {
  fridge: 0,
  freezer: 0,
  dishwasher: 0,
  cupboards: 0,
};

export default function Page() {
  // date range for calendar
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const maxMonth = new Date(now.getFullYear(), now.getMonth() + 3, 1);

  const [viewMonth, setViewMonth] = useState<Date>(startMonth);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [availableTimes, setAvailableTimes] = useState<string[]>([]);
  const [timesLoading, setTimesLoading] = useState(false);
  const [blockedDates, setBlockedDates] = useState<Set<string>>(new Set());

  // stepper
  const [step, setStep] = useState<number>(0);

  // ref for sliding section (scroll on back/next)
  const stepSectionRef = useRef<HTMLDivElement | null>(null);
  const scrollToStepTop = () => {
    if (stepSectionRef.current) {
      stepSectionRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      } as ScrollIntoViewOptions);
    }
  };

  // main form details
  const [form, setForm] = useState(initialFormState);

  // office-specific structured inputs
  const [roomsCount, setRoomsCount] = useState<number>(0);
  const [rooms, setRooms] = useState<OfficeRoom[]>([]);
  const [extras, setExtras] = useState<ExtrasSummary>(initialExtras);

  // booking completion state
  const [bookingComplete, setBookingComplete] = useState(false);
  const [lastBooking, setLastBooking] =
    useState<BookingSummaryState | null>(null);

  // grid calendar
  const grid = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(
      viewMonth.getFullYear(),
      viewMonth.getMonth() + 1,
      0
    ).getDate();
    const cells: { d: number; date?: Date; muted?: boolean }[] = [];
    for (let i = 0; i < startOffset; i++) cells.push({ d: 0, muted: true });
    for (let d = 1; d <= daysInMonth; d++)
      cells.push({
        d,
        date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d),
      });
    while (cells.length % 7) cells.push({ d: 0, muted: true });
    return cells;
  }, [viewMonth]);

  // ensure rooms array length matches roomsCount
  useEffect(() => {
    setRooms((prev) => {
      const next = [...prev];
      if (roomsCount > next.length) {
        for (let i = next.length; i < roomsCount; i++)
          next.push({ typeId: '', sizeId: '' });
      } else if (roomsCount < next.length) {
        next.splice(roomsCount);
      }
      return next;
    });
  }, [roomsCount]);

  // scroll to the step section when step changes (Back & Next)
  useEffect(() => {
    scrollToStepTop();
  }, [step]);

  // scroll to top on thank-you view
  useEffect(() => {
    if (bookingComplete && typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [bookingComplete]);

  // compute blocked days
  useEffect(() => {
    async function computeBlockedDays() {
      try {
        const staffSnap = await getDocs(collection(db, 'staff'));
        const staff = staffSnap.docs
          .map((d) => d.data())
          .filter((s) => (s as any).active !== false);

        const blocked = new Set<string>();
        const today0 = new Date();
        today0.setHours(0, 0, 0, 0);

        const globalMinNotice =
          staff.length > 0
            ? Math.min(
                ...staff.map((s: Record<string, unknown>) =>
                  Number(s['minNoticeHours'] ?? 12)
                )
              )
            : 12;

        for (let i = -30; i < 60; i++) {
          const dt = new Date();
          dt.setDate(today0.getDate() + i);
          dt.setHours(0, 0, 0, 0);
          const key = ymd(dt);
          const weekday = dt
            .toLocaleDateString('en-GB', { weekday: 'long' })
            .toLowerCase();

          if (dt < today0) {
            blocked.add(key);
            continue;
          }

          const staffAvailableToday = staff.some((s: Record<string, unknown>) => {
            const av = getDayAvail((s as any).availability, weekday);
            return av?.available === true;
          });
          if (!staffAvailableToday) {
            blocked.add(key);
            continue;
          }

          const cutoff = new Date(Date.now() + globalMinNotice * 3600_000);
          const endOfDay = new Date(dt);
          endOfDay.setHours(20, 0, 0, 0);
          if (endOfDay < cutoff) {
            blocked.add(key);
            continue;
          }
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
        if (!selectedDate) {
          setAvailableTimes([]);
          return;
        }
        const key = ymd(selectedDate);
        if (blockedDates.has(key)) {
          setAvailableTimes([]);
          return;
        }

        const ref = doc(db, 'unavailability', key);
        const snap = await getDoc(ref);
        const bookedLegacy = new Set<string>();
        if (snap.exists()) {
          const data = snap.data() as Record<string, unknown>;
          const booked = data['bookedTimeSlots'] as
            | Record<string, unknown>
            | undefined;
          if (booked && typeof booked === 'object') {
            for (const t of Object.keys(booked)) {
              if (Boolean(booked[t])) bookedLegacy.add(t);
            }
          } else {
            for (let h = 7; h <= 20; h++) {
              const k = `${h}:00`;
              if (Boolean((data as any)[k])) bookedLegacy.add(k);
            }
          }
        }

        const bookingsSnap = await getDocs(
          query(collection(db, 'bookings'), where('date', '==', key))
        );
        const bookings = bookingsSnap.docs.map(
          (d) => d.data() as Record<string, unknown>
        );

        const staffSnap = await getDocs(collection(db, 'staff'));
        const staff = staffSnap.docs
          .map((d) => d.data() as Record<string, unknown>)
          .filter((s: Record<string, unknown>) => s['active'] !== false);

        const weekday = selectedDate
          .toLocaleDateString('en-GB', { weekday: 'long' })
          .toLowerCase();
        const dayStaff = staff.filter((s: Record<string, unknown>) => {
          const av = getDayAvail((s as any).availability, weekday);
          return av?.available === true;
        });

        if (dayStaff.length === 0) {
          setAvailableTimes([]);
          return;
        }

        const minNotice = Math.min(
          ...dayStaff.map((s: Record<string, unknown>) => {
            const v = Number(s['minNoticeHours']);
            return Number.isFinite(v) ? v : 12;
          })
        );
        const noticeCutoff = new Date(Date.now() + minNotice * 3600_000);

        const candidate = ALL_TIMES.map((h) => `${h}:00`).filter(
          (k) => !bookedLegacy.has(k)
        );
        const refined: string[] = [];

        for (const k of candidate) {
          const [hh] = k.split(':');
          const slotDt = new Date(selectedDate);
          slotDt.setHours(parseInt(hh, 10), 0, 0, 0);
          if (slotDt < noticeCutoff) continue;
          const slotMins = timeToMinutes(k);
          let atLeastOne = false;

          for (const s of dayStaff) {
            const av = getDayAvail((s as any).availability, weekday);
            if (!av || !av.available) continue;
            const startM = timeToMinutes(av.start);
            const endM = timeToMinutes(av.end);
            if (!within(slotMins, startM, endM)) continue;
            const buffer = Number((s as any)['travelBufferMins'] ?? 30);
            const collides = bookings.some((b: Record<string, unknown>) => {
              if (!b['startTime'] || !b['endTime']) return false;
              const bs = timeToMinutes(b['startTime'] as string);
              const be = timeToMinutes(b['endTime'] as string);
              const bsExp = Math.max(0, bs - buffer);
              const beExp = be + buffer;
              return within(slotMins, bsExp, beExp);
            });
            if (!collides) {
              atLeastOne = true;
              break;
            }
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

  // Pricing
  const pricing = useMemo(() => {
    let roomHours = 0;
    for (const r of rooms) {
      const sizeW = SIZE_OPTIONS.find((s) => s.id === r.sizeId)?.weight ?? 0;
      const typeM = ROOM_TYPES.find((t) => t.id === r.typeId)?.multiplier ?? 0;
      roomHours += sizeW * typeM;
    }

    // extra allowance for toilets (assume ~1 cubicle per toilet room)
    const bathroomsCountForTime = rooms.filter(
      (r) => r.typeId === 'bathroom'
    ).length;
    const toiletsHours = bathroomsCountForTime * PER_CUBICLE_HOURS;

    const addOnHours =
      (extras.fridge ?? 0) * ADDON_HOURS.fridge +
      (extras.freezer ?? 0) * ADDON_HOURS.freezer +
      (extras.dishwasher ?? 0) * ADDON_HOURS.dishwasher +
      (extras.cupboards ?? 0) * ADDON_HOURS.cupboards;

    let raw = roomHours + toiletsHours + addOnHours;
    const mult = form.cleanliness
      ? CLEAN_MULTIPLIER[form.cleanliness] ?? 1
      : 1;
    raw *= mult;

    const baseEstimatedHours = Math.max(MIN_HOURS, roundUpToHalf(raw || 0));
    const teamApplied = baseEstimatedHours > TEAM_THRESHOLD_HOURS;
    const effectiveUnrounded = teamApplied
      ? baseEstimatedHours / TEAM_FACTOR
      : baseEstimatedHours;
    const estimatedHours = Math.max(
      MIN_HOURS,
      roundUpToHalf(effectiveUnrounded)
    );

    const addOnsTotal =
      (extras.fridge ?? 0) * ADDON_PRICES.fridge +
      (extras.freezer ?? 0) * ADDON_PRICES.freezer +
      (extras.dishwasher ?? 0) * ADDON_PRICES.dishwasher +
      (extras.cupboards ?? 0) * ADDON_PRICES.cupboards;

    const suppliesFee = form.products === 'bring' ? SUPPLIES_FEE : 0;
// 👇 pick the rate based on selectedDate
const hourlyRate = isWeekend(selectedDate) ? WEEKEND_HOURLY_RATE : WEEKDAY_HOURLY_RATE;

const labour = estimatedHours * hourlyRate;    const totalPrice =
      Math.round((labour + addOnsTotal + suppliesFee) * 100) / 100;

    return {
      estimatedHours,
      baseEstimatedHours,
      teamApplied,
      addOnsTotal,
      suppliesFee,
      labour,
      totalPrice,
    };
  }, [rooms, extras, form.cleanliness, form.products, selectedDate]);

  // simple summaries for display + storage
  const roomSummaries: RoomSummary[] = ROOM_TYPES
    .map((rt) => {
      const matching = rooms.filter((r) => r.typeId === rt.id);
      if (!matching.length) return null;
      return {
        typeId: rt.id,
        label: rt.label,
        count: matching.length,
        sizes: matching.map((r) => r.sizeId),
      } as RoomSummary;
    })
    .filter((r): r is RoomSummary => r !== null);

  const extrasSummary: ExtrasSummary = {
    fridge: extras.fridge ?? 0,
    freezer: extras.freezer ?? 0,
    dishwasher: extras.dishwasher ?? 0,
    cupboards: extras.cupboards ?? 0,
  };

  // whether to show actual quote vs initial message
  const hasQuoteInputs =
    !!form.cleanliness ||
    roomsCount > 0 ||
    roomSummaries.length > 0 ||
    extrasSummary.fridge > 0 ||
    extrasSummary.freezer > 0 ||
    extrasSummary.dishwasher > 0 ||
    extrasSummary.cupboards > 0 ||
    !!form.products;

  // submit
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDate || !selectedTime) {
      alert('Please select date and time.');
      return;
    }
    if (!form.customerName || !form.customerEmail || !form.customerPhone) {
      alert('Please fill name, email, and phone.');
      return;
    }
    if (!form.addressLine1 || !form.town || !form.postcode) {
      alert('Please select or enter the site address.');
      return;
    }

    const orderId = createOrderId();
    const bookingDate = ymd(selectedDate);
    const bookingTime = `${selectedTime}:00`;
    const submittedAt = new Date().toISOString();

    // Build full booking datetime
    const bookingDateTime = new Date(selectedDate);
    bookingDateTime.setHours(parseInt(selectedTime, 10), 0, 0, 0);

    // Due date = 24h before the booking start
    const dueDateTime = new Date(
      bookingDateTime.getTime() - 24 * 60 * 60 * 1000
    );
    const dueDate = ymd(dueDateTime);

    const normalisedPhone = toE164UK(form.customerPhone) || form.customerPhone;

    // Pretty display strings for Zap
    const bookingDatePrettyForZap = displayDate(selectedDate);
    const bookingTimePrettyForZap = displayHour(selectedTime);
    const dueDatePretty = displayDate(dueDateTime);

    const endTime = addHoursToTime(bookingTime, pricing.estimatedHours ?? 1);

    const serviceType = form.serviceType || 'Office Cleaning';

    const addOnsList: string[] = [];
    if ((extras.fridge ?? 0) > 0)
      addOnsList.push(`Fridge clean x${extras.fridge}`);
    if ((extras.freezer ?? 0) > 0)
      addOnsList.push(`Freezer clean x${extras.freezer}`);
    if ((extras.dishwasher ?? 0) > 0)
      addOnsList.push(`Dishwasher load/unload x${extras.dishwasher}`);
    if ((extras.cupboards ?? 0) > 0)
      addOnsList.push(`Kitchen cupboards x${extras.cupboards}`);

    const additionalRooms: string[] = rooms.map((r, i) => {
      const rt = ROOM_TYPES.find((t) => t.id === r.typeId)?.label ?? 'Room';
      const sz = SIZE_OPTIONS.find((s) => s.id === r.sizeId);
      const label = sz ? `${sz.label} (${sz.hint})` : '';
      return `Room ${i + 1} — ${rt}${label ? ` — ${label}` : ''}`;
    });

    // Office-specific room counts – only create keys for rooms that exist
    const officeRoomCounts: {
      openPlan?: number;
      meetingRooms?: number;
      privateOffices?: number;
      receptions?: number;
      corridors?: number;
      storageRooms?: number;
      kitchens?: number;
      bathrooms?: number;
    } = {};

    for (const r of rooms) {
      if (!r.typeId) continue;
      switch (r.typeId) {
        case 'open-plan':
          officeRoomCounts.openPlan = (officeRoomCounts.openPlan ?? 0) + 1;
          break;
        case 'meeting':
          officeRoomCounts.meetingRooms =
            (officeRoomCounts.meetingRooms ?? 0) + 1;
          break;
        case 'private-office':
          officeRoomCounts.privateOffices =
            (officeRoomCounts.privateOffices ?? 0) + 1;
          break;
        case 'reception':
          officeRoomCounts.receptions =
            (officeRoomCounts.receptions ?? 0) + 1;
          break;
        case 'corridor':
          officeRoomCounts.corridors =
            (officeRoomCounts.corridors ?? 0) + 1;
          break;
        case 'storage':
          officeRoomCounts.storageRooms =
            (officeRoomCounts.storageRooms ?? 0) + 1;
          break;
        case 'kitchen':
          officeRoomCounts.kitchens =
            (officeRoomCounts.kitchens ?? 0) + 1;
          break;
        case 'bathroom':
          officeRoomCounts.bathrooms =
            (officeRoomCounts.bathrooms ?? 0) + 1;
          break;
      }
    }

    const roomSelections = roomSummaries.map((r) => ({
      typeId: r.typeId,
      count: r.count,
      sizeId: r.sizes && r.sizes.length > 0 ? r.sizes[0] : '',
    }));

    const allRoomsSummary: AllRoomsSummaryItem[] = roomSummaries.map((r) => ({
      typeId: r.typeId,
      label: r.label,
      count: r.count,
      sizes: r.sizes,
    }));

    const zapPayload = {
      orderId,
      submittedAt,

      // customer details
      customerName: form.customerName,
      customerEmail: form.customerEmail,
      customerPhone: normalisedPhone,
      // address
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2,
      town: form.town,
      county: form.county,
      postcode: form.postcode,

      // service
      serviceType,
      cleanliness: form.cleanliness,
      products: form.products,
      additionalInfo: form.additionalInfo,
      access: form.access || '',
      accessNotes: form.keyLocation || '',

      // booking date/time
      bookingDate,
      bookingDatePretty: bookingDatePrettyForZap,
      bookingTimeFrom: bookingTime,
      bookingTimeFromPretty: bookingTimePrettyForZap,
      bookingTimeTo: endTime,
      estimatedHours: pricing.estimatedHours,
      baseEstimatedHours: pricing.baseEstimatedHours,
      twoCleaners: pricing.teamApplied,

      // due date (24h before)
      dueDate,
      dueDatePretty,
      dueDateTimeISO: dueDateTime.toISOString(),
      bookingDateTimeISO: bookingDateTime.toISOString(),

      // money
      totalPrice: pricing.totalPrice,
      totalPriceInPence: Math.round(pricing.totalPrice * 100),
      quoteAmount: pricing.totalPrice,
      quoteAmountInPence: Math.round(pricing.totalPrice * 100),
      quoteDate: bookingDate,

      // office room breakdown – only added when present
      ...officeRoomCounts,

      roomSelections,

      additionalRooms,
      roomsText: additionalRooms.join('\n'),
      addOns: addOnsList,
      addOnsText: addOnsList.length ? addOnsList.join('\n') : 'None',

      allRoomsSummary,
    };

    const {
      additionalRooms: _additionalRooms,
      ...zapForStorage
    } = zapPayload;

    const hourlyRate = isWeekend(selectedDate) ? WEEKEND_HOURLY_RATE : WEEKDAY_HOURLY_RATE;


    await setDoc(doc(db, 'bookings', orderId), {
      ...zapForStorage,
      roomSummaries,
      roomSelections,
      extrasSummary,
      address: {
        line1: form.addressLine1,
        line2: form.addressLine2,
        town: form.town,
        county: form.county,
        postcode: form.postcode,
      },
      date: bookingDate,
      startTime: bookingTime,
      endTime,
      labourRate: hourlyRate,
      suppliesFee: pricing.suppliesFee,
      addOnsTotal: pricing.addOnsTotal,
      labourCharge: pricing.labour,
      status: 'confirmed',
    });

    // finances logging + Zapier webhook
    try {
      const financesRef = collection(db, 'finances');

      // trigger Zapier webhook with full booking payload
      try {
        await fetch('https://hooks.zapier.com/hooks/catch/22652608/uz20jhf/', {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(zapPayload),
        });
      } catch (err) {
        console.error('Failed to send Zapier webhook for booking', err);
      }

      await addDoc(financesRef, {
        type: 'Income',
        name: `Office clean booking ${orderId}`,
        amount: pricing.totalPrice,
        frequency: 'One-time',
        createdAt: serverTimestamp(),
      });

      const STAFF_RATE = 12.21;
      const staffMultiplier = pricing.teamApplied ? 2 : 1;
      const staffPayTotal =
        (Number(pricing.estimatedHours) || 0) * STAFF_RATE * staffMultiplier;

      if (staffPayTotal > 0) {
        await addDoc(financesRef, {
          type: 'Expense',
          name: `Staff pay for ${orderId}`,
          amount: Number(staffPayTotal.toFixed(2)),
          frequency: 'One-time',
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      console.error('Failed to log finances for booking', err);
    }

    const bookingDisplayDate = displayDate(selectedDate);
    const bookingDisplayTime = displayHour(selectedTime);

    setLastBooking({
      orderId,
      bookingDate,
      bookingTime,
      bookingDisplayDate,
      bookingDisplayTime,
      customerName: form.customerName,
      customerEmail: form.customerEmail,
      customerPhone: form.customerPhone,
      address: {
        line1: form.addressLine1,
        line2: form.addressLine2,
        town: form.town,
        county: form.county,
        postcode: form.postcode,
      },
      totalPrice: pricing.totalPrice,
      estimatedHours: pricing.estimatedHours,
    });

    // reset form state
    setForm(initialFormState);
    setRoomsCount(0);
    setRooms([]);
    setExtras(initialExtras);
    setSelectedDate(null);
    setSelectedTime('');
    setStep(0);
    setBookingComplete(true);
  }

  // inputs/styles
  const input =
    'w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-[#0071bc]/25 focus:border-[#0071bc]';
  const select = input;
  const sectionTitle =
    'text-lg font-semibold text-[#0071bc] mb-4 pb-3 border-b border-gray-200';
  const smallMuted = 'text-xs text-gray-600';

  // step guards (now only for the sliding sections; contact/address is always visible)
  const canNext = useMemo(() => {
    if (step === 0) {
      return roomsCount >= 0 && !!form.cleanliness;
    }
    if (step === 1) {
      if (roomsCount === 0) return true;
      return rooms.every((r) => r.typeId && r.sizeId);
    }
    // step 2: extras & supplies
    if (step === 2) {
      return true;
    }
    // step 3: access
    if (step === 3) {
      return !!form.access && (form.access !== 'key' || !!form.keyLocation);
    }
    return true;
  }, [step, roomsCount, rooms, form.cleanliness, form.products, form.access, form.keyLocation]);

  const goNext = () => {
    if (!canNext) return;

    // On supplies/products step, show browser "please select" message
    if (step === 2 && !form.products && typeof document !== 'undefined') {
      const productsSelect = document.querySelector(
        'select[name="products"]'
      ) as HTMLSelectElement | null;
      if (productsSelect) {
        productsSelect.reportValidity();
      }
      return;
    }

    setStep((s) => Math.min(3, s + 1));
  };

  const goBack = () => setStep((s) => Math.max(0, s - 1));

  const containerClassName =
    bookingComplete && lastBooking ? 'container container-thankyou' : 'container';

  return (
    <>
      <IframeHeightReporter />
      <div>
        <style jsx global>{`
          html,
          body,
          #__next {
            height: 100%;
          }
          body {
            margin: 0;
            background: transparent;
          }
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
          .container-thankyou {
            min-height: auto !important;
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
            .fs-form {
              display: flex;
              flex-direction: column;
              height: 100%;
              overflow: visible;
            }
          }
          @media (max-width: 899px) {
            .forms-row {
              flex-direction: column !important;
              align-items: stretch;
            }
            .calendar-container {
              order: 0 !important;
              width: 100% !important;
              max-width: 100% !important;
            }
            .form-container {
              order: 1 !important;
              width: 100% !important;
              max-width: 100% !important;
            }
            .container {
              padding: 1rem !important;
            }
          }
          .date-cell {
            aspect-ratio: 1 / 1;
            min-width: 44px !important;
            min-height: 44px !important;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .calendar-container .grid.grid-cols-7 {
            grid-auto-rows: minmax(44px, 1fr);
          }
          .time-slots-grid button {
            white-space: nowrap;
            font-size: 12px;
            line-height: 1;
            padding-top: 0.45rem;
            padding-bottom: 0.45rem;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .calendar-container {
            align-self: stretch;
          }
          .calendar-container,
          .form-container {
            background: transparent !important;
          }
          .fs-form,
          .time-slot-container {
            background: transparent !important;
          }
          input,
          select,
          textarea {
            background: #fff !important;
          }
          .calendar-container button {
            background: ${UNAVAILABLE_BG} !important;
            color: ${PRIMARY} !important;
            font-weight: 500 !important;
            height: 36px !important;
          }
          .calendar-container .text-sm {
            font-weight: 500 !important;
          }
          .calendar-container.rounded-lg,
          .fs-form.rounded-lg {
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
            background-clip: padding-box;
          }
          @media (min-width: 1200px) {
            .container {
              padding: 3rem !important;
            }
            .date-cell {
              min-width: 52px !important;
              min-height: 52px !important;
            }
          }

          @keyframes slideFadeIn {
            from {
              opacity: 0;
              transform: translateX(24px);
            }
            to {
              opacity: 1;
              transform: translateX(0);
            }
          }
          .step-anim {
            animation: slideFadeIn 260ms ease forwards;
            will-change: transform, opacity;
          }

          @keyframes fadeInSoft {
            from {
              opacity: 0;
              transform: translateY(4px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          .animate-fade-in {
            animation: fadeInSoft 200ms ease-out;
          }
        `}</style>

        {bookingComplete && lastBooking ? (
          <div className={containerClassName}>
            <div className="forms-row">
              {/* Left: booking summary (similar width as calendar) */}
              <aside className="calendar-container self-start w-full md:w-4/12">
                <div className="bg-white rounded-lg shadow-md p-5 animate-fade-in">
                  <div
                    className="text-sm font-semibold mb-3"
                    style={{ color: PRIMARY }}
                  >
                    Booking details
                  </div>

                  <div className="space-y-2 text-xs text-gray-700">
                    <div>
                      <div className="font-medium text-gray-900">Order ID</div>
                      <div>{lastBooking.orderId}</div>
                    </div>

                    <div>
                      <div className="font-medium text-gray-900">
                        Date & time
                      </div>
                      <div>
                        {lastBooking.bookingDisplayDate} at{' '}
                        {lastBooking.bookingDisplayTime}
                      </div>
                    </div>

                    <div>
                      <div className="font-medium text-gray-900">
                        Contact details
                      </div>
                      <div>{lastBooking.customerName}</div>
                      <div>{lastBooking.customerEmail}</div>
                      <div>{lastBooking.customerPhone}</div>
                    </div>

                    <div>
                      <div className="font-medium text-gray-900">
                        Site address
                      </div>
                      <div>{lastBooking.address.line1}</div>
                      {lastBooking.address.line2 && (
                        <div>{lastBooking.address.line2}</div>
                      )}
                      <div>{lastBooking.address.town}</div>
                      {lastBooking.address.county && (
                        <div>{lastBooking.address.county}</div>
                      )}
                      <div>{lastBooking.address.postcode}</div>
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-3 mt-3 text-sm">
                    <div className="flex items-center justify-between text-xs text-gray-700 mb-1">
                      <span>Estimated time</span>
                      <span>{lastBooking.estimatedHours} hours</span>
                    </div>
                    <div className="flex items-center justify-between font-semibold text-base text-gray-900">
                      <span>Total price</span>
                      <span>{money.format(lastBooking.totalPrice)}</span>
                    </div>
                  </div>
                </div>
              </aside>

              {/* Right: thank-you message */}
              <section className="form-container w-full md:w-8/12 self-start">
                <div className="fs-form bg-white rounded-lg shadow-md p-6 animate-fade-in">
                  <div
                    className="text-lg font-semibold mb-1"
                    style={{ color: PRIMARY }}
                  >
                    Thank you
                    {lastBooking.customerName
                      ? `, ${lastBooking.customerName}`
                      : ''}
                    !
                  </div>
                  <p className="text-sm text-gray-700 mb-4">
                    Your office clean has been booked and is now awaiting
                    payment.
                  </p>

                  <div className="grid gap-3">
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800">
                      <div className="font-semibold text-[#0071bc] mb-1">
                        1. Check your email
                      </div>
                      <p className="text-xs text-gray-700">
                        We&apos;ve sent a confirmation with all booking details
                        and a secure payment link.
                      </p>
                    </div>

                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800">
                      <div className="font-semibold text-[#0071bc] mb-1">
                        2. Complete payment
                      </div>
                      <p className="text-xs text-gray-700">
                        Please make payment at least 24 hours before your
                        booking time to fully confirm the clean.
                      </p>
                    </div>

                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800">
                      <div className="font-semibold text-[#0071bc] mb-1">
                        3. On the day
                      </div>
                      <p className="text-xs text-gray-700">
                        Your cleaner will arrive within the chosen time slot and
                        follow any notes you&apos;ve provided about access and
                        security.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 text-xs text-gray-500">
                    If anything looks incorrect, just reply to your
                    confirmation email and we&apos;ll adjust it for you.
                  </div>
                </div>
              </section>
            </div>
          </div>
        ) : (
          <div className={containerClassName}>
            <div className="forms-row">
              {/* Calendar Container */}
              <aside className="calendar-container self-start w-full md:w-4/12 bg-white rounded-lg shadow-md p-5">
                <div>
                  {/* Calendar header */}
                  <div className="mb-3 flex items-center justify-between">
                    <button
                      className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90"
                      style={{
                        backgroundColor: UNAVAILABLE_BG,
                        color: PRIMARY,
                      }}
                      onClick={() =>
                        setViewMonth(
                          new Date(
                            viewMonth.getFullYear(),
                            viewMonth.getMonth() - 1,
                            1
                          )
                        )
                      }
                      disabled={ymd(viewMonth) === ymd(startMonth)}
                    >
                      &lt; Prev
                    </button>

                    <div
                      className="text-sm"
                      style={{ color: PRIMARY, fontWeight: 400 }}
                    >
                      {monthNames[viewMonth.getMonth()]}{' '}
                      {viewMonth.getFullYear()}
                    </div>

                    <button
                      className="rounded-md px-4 py-2 text-sm font-normal cursor-pointer hover:opacity-90"
                      style={{
                        backgroundColor: UNAVAILABLE_BG,
                        color: PRIMARY,
                      }}
                      onClick={() =>
                        setViewMonth(
                          new Date(
                            viewMonth.getFullYear(),
                            viewMonth.getMonth() + 1,
                            1
                          )
                        )
                      }
                      disabled={
                        viewMonth.getFullYear() === maxMonth.getFullYear() &&
                        viewMonth.getMonth() === maxMonth.getMonth()
                      }
                    >
                      Next &gt;
                    </button>
                  </div>

                  <div
                    className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium"
                    style={{ color: PRIMARY }}
                  >
                    {weekdays.map((w) => (
                      <div key={w} className="py-1">
                        {w}
                      </div>
                    ))}
                  </div>

                  <div className="mt-2 grid grid-cols-7 gap-2">
                    {grid.map((cell, i) => {
                      const isSelected =
                        cell.date &&
                        selectedDate &&
                        ymd(cell.date) === ymd(selectedDate);
                      const isBeforeToday = cell.date
                        ? new Date(
                            cell.date.getFullYear(),
                            cell.date.getMonth(),
                            cell.date.getDate()
                          ) < now
                        : false;
                      const isBlocked = cell.date
                        ? blockedDates.has(ymd(cell.date)) || isBeforeToday
                        : false;
                      const base =
                        'h-10 w-full rounded-md border text-[12px] flex items-center justify-center';
                      const inactive = cell.muted
                        ? ' border-gray-100 text-gray-300 bg-gray-50'
                        : '';
                      let styles: React.CSSProperties = {};
                      let extraCls =
                        ' cursor-pointer hover:opacity-90 text-white';

                      if (cell.muted) {
                        styles = {};
                        extraCls = '';
                      } else if (isBlocked) {
                        styles = {
                          backgroundColor: UNAVAILABLE_BG,
                          borderColor: UNAVAILABLE_BG,
                        };
                        extraCls = ' text-gray-400 cursor-not-allowed';
                      } else if (isSelected) {
                        styles = {
                          backgroundColor: PRIMARY,
                          borderColor: PRIMARY,
                        };
                      } else {
                        styles = {
                          backgroundColor: DATE_BG,
                          borderColor: DATE_BG,
                        };
                      }

                      return (
                        <div
                          key={i}
                          className={`${base} date-cell${inactive}${extraCls}`}
                          style={styles}
                          onClick={() => {
                            if (cell.date && !isBlocked)
                              setSelectedDate(cell.date!);
                          }}
                        >
                          {cell.d || ''}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="time-slot-container mt-5 rounded-lg shadow-sm p-4 inline-block w-full">
                  {!selectedDate ? (
                    <div className="text-xs text-gray-600">
                      Please select a date first
                    </div>
                  ) : (
                    <>
                      <h2
                        className="text-lg font-semibold mb-3"
                        style={{ color: PRIMARY }}
                      >
                        Select a time
                      </h2>

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
                                className={`p-3 text-center rounded-md text-xs cursor-pointer ${
                                  isSelected ? '' : 'hover:opacity-90'
                                }`}
                                style={{
                                  border: `1px solid ${
                                    isSelected ? PRIMARY : '#e5e7eb'
                                  }`,
                                  backgroundColor: isSelected
                                    ? 'rgba(0,113,188,0.08)'
                                    : '#fff',
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
                <form
                  className="fs-form bg-white rounded-lg shadow-md p-6"
                  onSubmit={onSubmit}
                >
                  {/* Selected Date Display */}
                  <div className="fs-field mb-4">
                    <div
                      className="selected-date text-sm font-medium"
                      style={{ color: PRIMARY }}
                    >
                      {displayDate(selectedDate)}
                    </div>
                  </div>

                  {/* CONTACT INFO (always visible at top) */}
                  <div className="rounded-2xl border border-gray-200 border border-[#e0e6ed] rounded-md shadow-[4px_6px_10px_-3px_#bfc9d4] p-4 sm:p-5">                    
                    <div className={sectionTitle}>Contact</div>
                    <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <input
                        className={input}
                        name="customerName"
                        placeholder="Company or contact name"
                        value={form.customerName}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            customerName: e.target.value,
                          }))
                        }
                        required
                      />
                      <input
                        className={input}
                        name="customerEmail"
                        type="email"
                        placeholder="Email"
                        value={form.customerEmail}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            customerEmail: e.target.value,
                          }))
                        }
                        required
                      />
                      <input
                        className={`${input} md:col-span-2`}
                        name="customerPhone"
                        placeholder="Phone number"
                        value={form.customerPhone}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            customerPhone: e.target.value,
                          }))
                        }
                        required
                      />
                    </div>
                  </div>

                  {/* ADDRESS */}
                  <div className="mt-6">
                    <AddressLookup
                      onAddressSelect={(addr) =>
                        setForm((prev) => ({
                          ...prev,
                          addressLine1: addr.line1 || '',
                          addressLine2: addr.line2 || '',
                          town: addr.town || '',
                          county: addr.county || '',
                          postcode: addr.postcode || '',
                        }))
                      }
                    />
                  </div>

                  {/* Sliding multi-step section with clearer separation */}
                  <div
                    key={`panel-${step}`}
                    ref={stepSectionRef}
                    className="step-anim mt-6 rounded-lg border border-gray-20 border border-[#e0e6ed] rounded-md shadow-[4px_6px_10px_-3px_#bfc9d4] px-4 py-4 md:px-5 md:py-5"
                  >
                    {/* STEP 0: ROOMS & FOOTFALL */}
                    {step === 0 && (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <label className="block text-sm font-medium text-gray-800 mb-1">
                            How many rooms?
                          </label>
                          <select
                            className={select}
                            value={roomsCount}
                            onChange={(e) =>
                              setRoomsCount(
                                Math.max(
                                  0,
                                  parseInt(e.target.value || '0', 10)
                                )
                              )
                            }
                          >
                            {[
                              0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20,
                            ].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                         
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-800 mb-1">
                            Footfall level
                          </label>
                          <select
                            className={select}
                            value={form.cleanliness}
                            onChange={(e) =>
                              setForm((p) => ({
                                ...p,
                                cleanliness: e.target.value,
                              }))
                            }
                            required
                          >
                            <option value="">Select</option>
                            <option value="quite-clean">Low</option>
                            <option value="average">Typical</option>
                            <option value="quite-dirty">High</option>
                            <option value="filthy">Very high</option>
                          </select>
                        
                        </div>
                      </div>
                    )}

                    {/* STEP 1: ROOM DETAILS */}
                    {step === 1 &&
                      (roomsCount === 0 ? (
                        <div className="text-sm text-gray-700">
                          No extra room details to add — continue to extras and
                          supplies.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {rooms.map((r, idx) => (
                            <div
                              key={idx}
                              className="border-gray-200 grid grid-cols-1 md:grid-cols-2 gap-3 border rounded-lg p-3 bg-white"
                            >
                              <div>
                                <label className="block text-sm font-medium text-gray-800 mb-1">
                                  Room {idx + 1} — type
                                </label>
                                <select
                                  className={select}
                                  value={r.typeId}
                                  onChange={(e) => {
                                    const val =
                                      e.target.value as RoomTypeId | '';
                                    setRooms((prev) =>
                                      prev.map((x, i) =>
                                        i === idx ? { ...x, typeId: val } : x
                                      )
                                    );
                                  }}
                                >
                                  <option value="">Select type</option>
                                  {ROOM_TYPES.map((rt) => (
                                    <option key={rt.id} value={rt.id}>
                                      {rt.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-800 mb-1">
                                  Approx size
                                </label>
                                <select
                                  className={select}
                                  value={r.sizeId}
                                  onChange={(e) => {
                                    const val =
                                      e.target.value as SizeIdLocal | '';
                                    setRooms((prev) =>
                                      prev.map((x, i) =>
                                        i === idx ? { ...x, sizeId: val } : x
                                      )
                                    );
                                  }}
                                >
                                  <option value="">Select</option>
                                  {SIZE_OPTIONS.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {`${s.label} – ${s.hint}`}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}

                    {/* STEP 2: EXTRAS & SUPPLIES */}
                    {step === 2 && (
                      <>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {[
                            {
                              key: 'fridge',
                              label: 'Fridge clean',
                              price: ADDON_PRICES.fridge,
                            },
                            {
                              key: 'freezer',
                              label: 'Freezer clean',
                              price: ADDON_PRICES.freezer,
                            },
                            {
                              key: 'dishwasher',
                              label: 'Dishwasher load/unload',
                              price: ADDON_PRICES.dishwasher,
                            },
                            {
                              key: 'cupboards',
                              label: 'Kitchen cupboards (count)',
                              price: ADDON_PRICES.cupboards,
                            },
                          ].map((item) => (
                            <div key={item.key}>
                              <label className="block text-sm font-medium text-gray-800 mb-1">
                                {item.label}{' '}
                                {item.price
                                  ? `(+${money.format(item.price)} each)`
                                  : ''}
                              </label>
                              <select
                                className={select}
                                value={(extras as any)[item.key] ?? 0}
                                onChange={(e) => {
                                  const val = Math.max(
                                    0,
                                    parseInt(e.target.value || '0', 10)
                                  );
                                  setExtras((prev) => ({
                                    ...prev,
                                    [item.key]: val,
                                  }));
                                }}
                              >
                                {[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ))}
                        </div>

                        <div className="mt-4">
                          <label className="mb-1 block text-xs font-medium text-gray-700">
                            Supplies{' '}
                            <span className="text-red-500">(Required)*</span>
                          </label>
                          <select
                            className={select}
                            name="products"
                            value={form.products}
                            onChange={(e) =>
                              setForm((p) => ({
                                ...p,
                                products: e.target.value,
                              }))
                            }
                            required
                          >
                            <option value="">Select option</option>
                            <option value="bring">
                              Bring our supplies (+{money.format(SUPPLIES_FEE)})
                            </option>
                            <option value="customer">Use site supplies</option>
                          </select>
                        </div>
                      </>
                    )}

                    {/* STEP 3: SITE & ACCESS */}
                    {step === 3 && (
                      <>
                        <div className={sectionTitle}>Site &amp; access</div>

                        <div className="grid grid-cols-1 gap-4 mt-2">
                          <div className="fs-field">
                            <label
                              className="fs-label block text-gray-700 mb-1"
                              htmlFor="access"
                            >
                              How will we access the site?
                            </label>
                            <select
                              className="fs-select w-full p-2 rounded-lg"
                              id="access"
                              name="access"
                              value={form.access || ''}
                              onChange={(e) =>
                                setForm((p) => ({
                                  ...p,
                                  access: e.target.value,
                                }))
                              }
                              required
                              style={{
                                border: '1px solid #e6e6e6',
                                fontWeight: 400,
                                outline: 'none',
                              }}
                            >
                              <option value="" disabled>
                                Select access method
                              </option>
                              <option value="let-in">
                                A member of staff will meet the cleaners
                              </option>
                              <option value="alternative">
                                Alternative access (code, reception, lockbox,
                                etc.)
                              </option>
                            </select>
                          </div>

                          {form.access === 'alternative' && (
                            <div className="fs-field">
                              <label
                                className="text-gray-700 fs-label block text-gray-700 mb-1"
                                htmlFor="keyLocation"
                              >
                                Alternative access details
                              </label>
                              <input
                                className="fs-input w-full p-2 border rounded-lg"
                                type="text"
                                id="keyLocation"
                                name="keyLocation"
                                value={form.keyLocation || ''}
                                onChange={(e) =>
                                  setForm((p) => ({
                                    ...p,
                                    keyLocation: e.target.value,
                                  }))
                                }
                                placeholder="e.g., building entry code, reception instructions, lockbox, security desk…"
                                required
                              />
                            </div>
                          )}

                          <div className="fs-field">
                            <label
                              className="text-gray-700 fs-label block text-gray-700 mb-1"
                              htmlFor="additionalInfo"
                            >
                              Anything else we should know?
                            </label>
                            <textarea
                              id="additionalInfo"
                              className={`${input} h-24`}
                              value={form.additionalInfo}
                              onChange={(e) =>
                                setForm((p) => ({
                                  ...p,
                                  additionalInfo: e.target.value,
                                }))
                              }
                              placeholder="Parking, alarm codes, security procedures, special instructions…"
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Navigation */}
                  <div className="fs-button-group flex items-center justify-between gap-3 mt-6 mb-4">
                    <button
                      type="button"
                      onClick={goBack}
                      disabled={step === 0}
                      className="rounded-lg px-4 py-3 border text-sm hover:opacity-90 disabled:opacity-60"
                      style={{
                        borderColor: '#e5e7eb',
                        color: '#111827',
                        background: '#fff',
                      }}
                    >
                      Back
                    </button>

                    {step < 3 ? (
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
                        Book now — {money.format(pricing.totalPrice)}
                      </button>
                    )}
                  </div>

                  {/* Summary & price BELOW the form */}
                  <div className="fs-price-breakdown bg-gray-50 p-4 rounded-lg mb-4 border border-gray-100 mt-2">
                    <div className="font-semibold mb-2 text-sm text-gray-900">
                      Summary &amp; price
                    </div>

                    {!hasQuoteInputs ? (
                      <div className="text-xs text-gray-600 py-3 animate-fade-in">
                        Enter a few details above to see an instant estimated
                        time and price for your office clean.
                      </div>
                    ) : (
                      <div className="space-y-3 animate-fade-in">
                        {roomSummaries.length > 0 && (
                          <div className="text-xs text-gray-700">
                            <div className="font-medium mb-1">Rooms</div>
                            <div className="space-y-1">
                              {roomSummaries.map((r, idx) => {
                                const sizeLabels = r.sizes
                                  .filter(Boolean)
                                  .map((sid) => {
                                    const opt = SIZE_OPTIONS.find(
                                      (s) => s.id === sid
                                    );
                                    return opt ? opt.label.toLowerCase() : sid;
                                  });
                                return (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between rounded-md border border-gray-200 bg-white px-2.5 py-1.5"
                                  >
                                    <div className="pr-2">
                                      <div className="text-[11px] font-medium text-gray-900">
                                        {r.label}
                                      </div>
                                      {sizeLabels.length > 0 && (
                                        <div className="text-[11px] text-gray-500">
                                          Sizes: {sizeLabels.join(', ')}
                                        </div>
                                      )}
                                    </div>
                                    <div className="text-[11px] font-semibold text-gray-900">
                                      × {r.count}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {(extrasSummary.fridge > 0 ||
                          extrasSummary.freezer > 0 ||
                          extrasSummary.dishwasher > 0 ||
                          extrasSummary.cupboards > 0) && (
                          <div className="text-xs text-gray-700">
                            <div className="font-medium mb-1">Extras</div>
                            <div className="flex flex-wrap gap-1">
                              {extrasSummary.fridge > 0 && (
                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px]">
                                  Fridge clean × {extrasSummary.fridge}
                                </span>
                              )}
                              {extrasSummary.freezer > 0 && (
                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px]">
                                  Freezer clean × {extrasSummary.freezer}
                                </span>
                              )}
                              {extrasSummary.dishwasher > 0 && (
                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px]">
                                  Dishwasher × {extrasSummary.dishwasher}
                                </span>
                              )}
                              {extrasSummary.cupboards > 0 && (
                                <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px]">
                                  Kitchen cupboards × {extrasSummary.cupboards}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {form.cleanliness && (
                          <div className="text-xs text-gray-700">
                            <div className="font-medium mb-1">
                              Footfall level
                            </div>
                            <div className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-800 inline-block">
                              {CLEAN_LABELS[form.cleanliness] ??
                                form.cleanliness}
                            </div>
                          </div>
                        )}

                        {form.products && (
                          <div className="text-xs text-gray-700">
                            <div className="font-medium mb-1">Supplies</div>
                            <div className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-800 inline-block">
                              {form.products === 'bring'
                                ? `We bring our supplies (+${money.format(
                                    SUPPLIES_FEE
                                  )})`
                                : 'Use site supplies'}
                            </div>
                          </div>
                        )}

                        <div className="border-t border-gray-200 pt-3 mt-1 text-sm">
                          <div className="flex items-center justify-between text-xs text-gray-700 mb-1">
                            <span>Estimated time</span>
                            <span>{pricing.estimatedHours} hours</span>
                          </div>
                          <div className="flex items-center justify-between font-semibold text-base text-gray-900">
                            <span>Total price</span>
                            <span>{money.format(pricing.totalPrice)}</span>
                          </div>
                        </div>

                        {pricing.teamApplied && (
                          <div
                            className="mt-3 rounded-md border px-3 py-2 text-xs"
                            style={{
                              backgroundColor: '#eef6ff',
                              borderColor: '#dbeafe',
                              color: PRIMARY,
                            }}
                          >
                            ✓ Two cleaners may be assigned to this booking
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </form>
              </section>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
