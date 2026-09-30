import { mount } from 'svelte'
import './styles/app.css'
import App from './App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('Missing #app mount point')

// Gallery is development-only and must stay outside the production application chunk.
if (import.meta.env.DEV && location.pathname === '/__gallery') {
  const { default: Gallery } = await import('@app/gallery/Gallery.svelte')
  mount(Gallery, { target })
} else {
  mount(App, { target })
}
