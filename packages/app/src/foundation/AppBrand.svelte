<script lang="ts">
  interface Props {
    name?: string
  }

  let { name = 'AutoNote' }: Props = $props()
</script>

<div class="flex flex-col items-center gap-4 text-center">
  <img src="/autonote-logo.png" alt={name} width="96" height="96" class="rounded-2xl" />
  <h1 class="text-2xl font-semibold">{name}</h1>
</div>
