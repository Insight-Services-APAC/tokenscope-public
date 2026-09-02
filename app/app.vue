<template>
  <!--
    Route-level progress bar. It covers only the residual gap between a click
    and the next page's shell (middleware session check, chunk load): pages
    must not hold suspense on data — docs/design/admin-nav-responsiveness.md D1.
  -->
  <NuxtLoadingIndicator color="#582873" :height="3" :throttle="0" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
