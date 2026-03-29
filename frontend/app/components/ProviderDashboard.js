'use client'
import { useState, useEffect } from 'react'

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const TIME_OPTIONS = []
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 30) {
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    TIME_OPTIONS.push(`${hh}:${mm}`)
  }
}

export default function ProviderDashboard({ api }) {
  const [providers, setProviders] = useState([])
  const [name, setName] = useState('')
  const [service, setService] = useState('')

  useEffect(() => { loadProviders() }, [])

  async function loadProviders() {
    const res = await fetch(`${api}/providers`)
    const data = await res.json()
    setProviders(data)
  }

  async function registerProvider(e) {
    e.preventDefault()
    await fetch(`${api}/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, service }),
    })
    setName('')
    setService('')
    loadProviders()
  }

  return (
    <div data-testid="provider-view" style={{ padding: 20 }}>
      <h2>Provider Dashboard</h2>
      <form onSubmit={registerProvider} style={{ marginBottom: 20, display: 'flex', gap: 8 }}>
        <input
          data-testid="provider-name-input"
          placeholder="Provider name"
          value={name}
          onChange={e => setName(e.target.value)}
          required
          style={{ padding: '6px 10px' }}
        />
        <input
          data-testid="provider-service-input"
          placeholder="Service description"
          value={service}
          onChange={e => setService(e.target.value)}
          required
          style={{ padding: '6px 10px' }}
        />
        <button data-testid="register-provider-btn" type="submit" style={{ padding: '6px 14px' }}>
          Register Provider
        </button>
      </form>

      {providers.map(p => (
        <ProviderPanel key={p.id} provider={p} api={api} onRefresh={loadProviders} />
      ))}
    </div>
  )
}

function ProviderPanel({ provider, api, onRefresh }) {
  const [duration, setDuration] = useState(String(provider.duration_minutes))
  const [buffer, setBuffer] = useState(String(provider.buffer_minutes))
  const [bookings, setBookings] = useState([])
  const [availability, setAvailability] = useState(() => {
    const init = {}
    DAYS.forEach(d => {
      const blocks = provider.availability?.[d] || []
      init[d] = { enabled: blocks.length > 0, blocks: blocks.length > 0 ? blocks.map(b => ({ start_time: b.start_time, end_time: b.end_time })) : [{ start_time: '09:00', end_time: '17:00' }] }
    })
    return init
  })

  useEffect(() => { loadBookings() }, [])

  async function loadBookings() {
    const res = await fetch(`${api}/providers/${provider.id}/bookings`)
    const data = await res.json()
    setBookings(data)
  }

  async function saveConfig() {
    await fetch(`${api}/providers/${provider.id}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_minutes: parseInt(duration), buffer_minutes: parseInt(buffer) }),
    })
  }

  async function saveAvailability() {
    const days = DAYS.filter(d => availability[d].enabled).map(d => ({
      day_of_week: d,
      blocks: availability[d].blocks,
    }))
    await fetch(`${api}/providers/${provider.id}/availability`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
    onRefresh()
  }

  async function cancelBooking(bookingId) {
    await fetch(`${api}/bookings/${bookingId}`, { method: 'DELETE' })
    loadBookings()
  }

  function toggleDay(day) {
    setAvailability(prev => ({
      ...prev,
      [day]: { ...prev[day], enabled: !prev[day].enabled }
    }))
  }

  function addBlock(day) {
    setAvailability(prev => ({
      ...prev,
      [day]: { ...prev[day], blocks: [...prev[day].blocks, { start_time: '09:00', end_time: '17:00' }] }
    }))
  }

  function removeBlock(day, idx) {
    setAvailability(prev => ({
      ...prev,
      [day]: { ...prev[day], blocks: prev[day].blocks.filter((_, i) => i !== idx) }
    }))
  }

  function updateBlock(day, idx, field, val) {
    setAvailability(prev => {
      const blocks = prev[day].blocks.map((b, i) => i === idx ? { ...b, [field]: val } : b)
      return { ...prev, [day]: { ...prev[day], blocks } }
    })
  }

  const id = provider.id

  return (
    <div style={{ border: '1px solid #ccc', borderRadius: 6, padding: 16, marginBottom: 20 }}>
      <h3>
        {provider.name} — <em>{provider.service}</em>
        {' '}
        <span data-testid={`provider-id-${id}`} style={{ fontSize: 12, color: '#666' }}>ID: {id}</span>
      </h3>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <label>
          Duration:
          <select
            data-testid={`duration-select-${id}`}
            value={duration}
            onChange={e => { setDuration(e.target.value); }}
            style={{ marginLeft: 6 }}
          >
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
        </label>
        <label>
          Buffer:
          <select
            data-testid={`buffer-select-${id}`}
            value={buffer}
            onChange={e => { setBuffer(e.target.value); }}
            style={{ marginLeft: 6 }}
          >
            <option value="0">0 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
          </select>
        </label>
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>Weekly Availability:</strong>
        {DAYS.map(day => (
          <div key={day} style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                data-testid={`day-toggle-${id}-${day}`}
                checked={availability[day].enabled}
                onChange={() => toggleDay(day)}
              />
              <span style={{ textTransform: 'capitalize', minWidth: 80 }}>{day}</span>
            </label>
            {availability[day].enabled && (
              <div style={{ marginLeft: 20 }}>
                {availability[day].blocks.map((block, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                    <select
                      data-testid={`time-block-start-${id}-${day}-${idx}`}
                      value={block.start_time}
                      onChange={e => updateBlock(day, idx, 'start_time', e.target.value)}
                    >
                      {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span>to</span>
                    <select
                      data-testid={`time-block-end-${id}-${day}-${idx}`}
                      value={block.end_time}
                      onChange={e => updateBlock(day, idx, 'end_time', e.target.value)}
                    >
                      {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {availability[day].blocks.length > 1 && (
                      <button
                        data-testid={`remove-time-block-${id}-${day}-${idx}`}
                        onClick={() => removeBlock(day, idx)}
                        style={{ padding: '2px 8px' }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button
                  data-testid={`add-time-block-${id}-${day}`}
                  onClick={() => addBlock(day)}
                  style={{ marginTop: 4, padding: '2px 8px' }}
                >
                  + Add Time Block
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        data-testid={`save-availability-${id}`}
        onClick={async () => { await saveConfig(); await saveAvailability(); }}
        style={{ padding: '6px 14px', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
      >
        Save
      </button>

      <div style={{ marginTop: 16 }}>
        <strong>Upcoming Bookings:</strong>
        {bookings.length === 0 && <div style={{ color: '#888', marginTop: 4 }}>No bookings</div>}
        {bookings.map(b => (
          <div
            key={b.id}
            data-testid={`booking-item-${b.id}`}
            style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6, padding: '6px 10px', background: '#f5f5f5', borderRadius: 4 }}
          >
            <span>{b.client_name}</span>
            <span>{b.booking_date}</span>
            <span>{formatTime(b.start_time)}</span>
            <button
              data-testid={`cancel-booking-${b.id}`}
              onClick={() => cancelBooking(b.id)}
              style={{ marginLeft: 'auto', padding: '3px 10px', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function formatTime(t) {
  // t is "HH:MM:SS" or "HH:MM"
  const [h, m] = t.split(':')
  const hour = parseInt(h)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12
  return `${h12}:${m} ${ampm}`
}
