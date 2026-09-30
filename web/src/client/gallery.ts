import { mount } from 'svelte'
import Gallery from '@app/gallery/Gallery.svelte'

export function mountGallery(target: HTMLElement): void {
  mount(Gallery, { target })
}
