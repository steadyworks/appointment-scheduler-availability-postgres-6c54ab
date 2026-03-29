'use client'
import { useState } from 'react'
import ProviderDashboard from './components/ProviderDashboard'
import ClientBooking from './components/ClientBooking'

const API = 'http://localhost:3001'

export default function Home() {
  const [view, setView] = useState('provider')

  async function deleteAll() {
    await fetch(`${API}/data`, { method: 'DELETE' })
    window.location.reload()
  }

  return (
    <div>
      <nav style={{ background: '#1a1a2e', color: '#fff', padding: '10px 20px', display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button
          data-testid="nav-provider"
          onClick={() => setView('provider')}
          style={{ padding: '8px 16px', cursor: 'pointer', background: view === 'provider' ? '#e94560' : '#16213e', color: '#fff', border: 'none', borderRadius: 4 }}
        >
          Provider Dashboard
        </button>
        <button
          data-testid="nav-client"
          onClick={() => setView('client')}
          style={{ padding: '8px 16px', cursor: 'pointer', background: view === 'client' ? '#e94560' : '#16213e', color: '#fff', border: 'none', borderRadius: 4 }}
        >
          Client Booking
        </button>
        <button
          data-testid="delete-all-btn"
          onClick={deleteAll}
          style={{ marginLeft: 'auto', padding: '8px 16px', cursor: 'pointer', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 4 }}
        >
          Delete All Data
        </button>
      </nav>

      {view === 'provider' && <ProviderDashboard api={API} />}
      {view === 'client' && <ClientBooking api={API} />}
    </div>
  )
}
