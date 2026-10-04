<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { getContext } from 'svelte';
	const surface = getContext<(() => HTMLElement | undefined) | undefined>('autonote-surface');

	let { ...restProps }: DialogPrimitive.PortalProps = $props();
</script>

<DialogPrimitive.Portal to={surface?.() ?? 'body'} {...restProps} />
