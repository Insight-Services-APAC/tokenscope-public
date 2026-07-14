<template>
  <div class="min-h-screen flex flex-col bg-paper">
    <NavAppHeader />
    <main class="flex-1">
      <slot />
    </main>
    <NavAppFooter />
  </div>
</template>
