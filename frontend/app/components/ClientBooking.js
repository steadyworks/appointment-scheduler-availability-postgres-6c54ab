'use client'
import { useState, useEffect, useRef } from 'react'

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']

export default function ClientBooking({ api }) {
  const [providers, setProviders] = useState([])
  const [selectedProvider, setSelectedProvider] = useState(null)

  useEffect(() => { loadProviders() }, [])

  async function loadProviders() {
    const res = await fetch(`${api}/providers`)
    setProviders(await res.json())
  }

  function selectProvider(p) {
    if (selectedProvider?.id === p.id) {
      setSelectedProvider(null)
    } else {
      setSelectedProvider(p)
    }
  }

  return (
    <div data-testid="client-view" style={{ padding: 20 }}>
      <h2>Client Booking</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {providers.map(p => (
          <div
            key={p.id}
            data-testid={`provider-card-${p.id}`}
            onClick={() => selectProvider(p)}
            style={{
              border: `2px solid ${selectedProvider?.id === p.id ? '#e94560' : '#ccc'}`,
              borderRadius: 8,
              padding: '12px 18px',
              cursor: 'pointer',
              minWidth: 160,
              background: selectedProvider?.id === p.id ? '#fff0f3' : '#fff',
            }}
          >
            <div style={{ fontWeight: 'bold' }}>{p.name}</div>
            <div style={{ color: '#666', fontSize: 13 }}>{p.service}</div>
          </div>
        ))}
      </div>

      {selectedProvider && (
        <ProviderSlots
          key={selectedProvider.id}
          provider={selectedProvider}
          api={api}
        />
      )}
    </div>
  )
}

function ProviderSlots({ provider, api }) {
  const [slots, setSlots] = useState({})
  const [waitlistDates, setWaitlistDates] = useState({})
  const [bookingSlot, setBookingSlot] = useState(null)
  const [clientName, setClientName] = useState('')
  const [waitlistDay, setWaitlistDay] = useState(null)
  const [waitlistName, setWaitlistName] = useState('')
  const [waitlistResult, setWaitlistResult] = useState(null)
  const [error, setError] = useState('')
  const [holds, setHolds] = useState([])
  const [storedClientName, setStoredClientName] = useState('')
  const holdPollRef = useRef(null)

  useEffect(() => {
    loadSlots()
    // If we have a stored client name, poll for holds
    const stored = sessionStorage.getItem(`hold_name_${provider.id}`)
    if (stored) {
      setStoredClientName(stored)
      pollHolds(stored)
    }
    return () => { if (holdPollRef.current) clearInterval(holdPollRef.current) }
  }, [])

  async function loadSlots() {
    const res = await fetch(`${api}/providers/${provider.id}/slots`)
    setSlots(await res.json())
  }

  function pollHolds(name) {
    if (holdPollRef.current) clearInterval(holdPollRef.current)
    holdPollRef.current = setInterval(async () => {
      const res = await fetch(`${api}/holds?client_name=${encodeURIComponent(name)}&provider_id=${provider.id}`)
      const data = await res.json()
      setHolds(data)
      if (data.length > 0) {
        loadSlots()
      }
    }, 2000)
  }

  async function bookSlot(e) {
    e.preventDefault()
    setError('')
    try {
      const res = await fetch(`${api}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          client_name: clientName,
          booking_date: bookingSlot.date,
          start_time: bookingSlot.time,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        setError(err.detail || 'Slot is no longer available')
        return
      }
      // Store client name to poll for holds
      sessionStorage.setItem(`hold_name_${provider.id}`, clientName)
      setStoredClientName(clientName)
      pollHolds(clientName)
      setBookingSlot(null)
      setClientName('')
      loadSlots()
    } catch {
      setError('Failed to book slot')
    }
  }

  async function joinWaitlist(e) {
    e.preventDefault()
    const res = await fetch(`${api}/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider_id: provider.id,
        client_name: waitlistName,
        booking_date: waitlistDay.date,
      }),
    })
    const data = await res.json()
    // Store name for polling
    sessionStorage.setItem(`hold_name_${provider.id}`, waitlistName)
    setStoredClientName(waitlistName)
    pollHolds(waitlistName)
    setWaitlistResult({ position: data.position, name: waitlistName, day: waitlistDay.label })
    setWaitlistDay(null)
    setWaitlistName('')
  }

  async function confirmHold(holdId) {
    const res = await fetch(`${api}/holds/${holdId}/confirm`, { method: 'POST' })
    if (res.ok) {
      setHolds(h => h.filter(x => x.id !== holdId))
      loadSlots()
    }
  }

  // Build day entries with dates
  function buildDayEntries() {
    // next 5 weekdays from tomorrow
    const result = []
    let d = new Date()
    d.setDate(d.getDate() + 1)
    while (result.length < 5) {
      if (d.getDay() !== 0 && d.getDay() !== 6) {
        const dow = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getDay()]
        result.push({
          label: dow.charAt(0).toUpperCase() + dow.slice(1),
          day: dow,
          date: d.toISOString().split('T')[0],
        })
      }
      d = new Date(d)
      d.setDate(d.getDate() + 1)
    }
    return result
  }

  const dayEntries = buildDayEntries()

  return (
    <div style={{ marginTop: 16 }}>
      <h3>{provider.name} — {provider.service}</h3>

      {/* Active holds */}
      {holds.map(hold => (
        <HoldBanner key={hold.id} hold={hold} onConfirm={() => confirmHold(hold.id)} onExpire={() => {
          setHolds(h => h.filter(x => x.id !== hold.id))
          loadSlots()
        }} />
      ))}

      {waitlistResult && (
        <div style={{ background: '#d5f5e3', padding: 10, borderRadius: 4, marginBottom: 12 }}>
          {waitlistResult.name}, you are on the waitlist for {waitlistResult.day} at position #{waitlistResult.position}.
        </div>
      )}

      {error && <div style={{ color: 'red', marginBottom: 8 }}>{error}</div>}

      {dayEntries.map(entry => {
        const daySlots = slots[entry.day] || []
        const hasSlots = daySlots.length > 0

        return (
          <div key={entry.day} style={{ marginBottom: 16 }}>
            <strong style={{ textTransform: 'capitalize' }}>{entry.label}</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {hasSlots ? (
                daySlots.map(slotTime => {
                  const timeKey = slotTime.replace(':', '').padStart(4, '0')
                  const isBooking = bookingSlot?.day === entry.day && bookingSlot?.time === slotTime
                  return (
                    <div key={slotTime}>
                      <button
                        data-testid={`slot-${entry.day}-${timeKey}`}
                        onClick={() => {
                          setBookingSlot({ day: entry.day, time: slotTime, date: entry.date })
                          setError('')
                        }}
                        style={{ padding: '6px 12px', background: isBooking ? '#e94560' : '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      >
                        {slotTime}
                      </button>
                      {isBooking && (
                        <form onSubmit={bookSlot} style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                          <input
                            data-testid="client-name-input"
                            placeholder="Your name"
                            value={clientName}
                            onChange={e => setClientName(e.target.value)}
                            required
                            style={{ padding: '4px 8px' }}
                          />
                          <button
                            data-testid="confirm-booking-btn"
                            type="submit"
                            style={{ padding: '4px 12px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                          >
                            Book
                          </button>
                          <button type="button" onClick={() => setBookingSlot(null)} style={{ padding: '4px 8px' }}>Cancel</button>
                        </form>
                      )}
                    </div>
                  )
                })
              ) : (
                <div>
                  <button
                    data-testid={`join-waitlist-${entry.day}`}
                    onClick={() => setWaitlistDay(entry)}
                    style={{ padding: '6px 12px', background: '#f39c12', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                  >
                    Join Waitlist
                  </button>
                  {waitlistDay?.day === entry.day && (
                    <form onSubmit={joinWaitlist} style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                      <input
                        data-testid="waitlist-name-input"
                        placeholder="Your name"
                        value={waitlistName}
                        onChange={e => setWaitlistName(e.target.value)}
                        required
                        style={{ padding: '4px 8px' }}
                      />
                      <button
                        data-testid="join-waitlist-confirm-btn"
                        type="submit"
                        style={{ padding: '4px 12px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                      >
                        Join
                      </button>
                      <button type="button" onClick={() => setWaitlistDay(null)} style={{ padding: '4px 8px' }}>Cancel</button>
                    </form>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HoldBanner({ hold, onConfirm, onExpire }) {
  const [seconds, setSeconds] = useState(() => {
    const remaining = Math.max(0, Math.round((new Date(hold.expires_at) - Date.now()) / 1000))
    return remaining
  })

  useEffect(() => {
    if (seconds <= 0) { onExpire(); return }
    const timer = setInterval(() => {
      setSeconds(s => {
        if (s <= 1) {
          clearInterval(timer)
          onExpire()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  if (seconds <= 0) return null

  return (
    <div style={{ background: '#fef9e7', border: '2px solid #f39c12', borderRadius: 6, padding: 12, marginBottom: 12 }}>
      <div>
        <strong>Reservation Hold!</strong> You have a slot reserved for {hold.booking_date} at {hold.start_time}.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
        <span>Time remaining: <strong data-testid="hold-timer">{seconds}</strong> seconds</span>
        <button
          data-testid="confirm-hold-btn"
          onClick={onConfirm}
          style={{ padding: '6px 14px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          Confirm Booking
        </button>
      </div>
    </div>
  )
}
