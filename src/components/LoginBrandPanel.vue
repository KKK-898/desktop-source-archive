<script setup lang="ts">
import gaogeLogo from '../assets/new-theme-gaoge-logo.png'
import { loginCustomerRows, loginServiceStats } from '../login-customers'
</script>

<template>
  <aside class="login-brand-panel" aria-labelledby="login-brand-title">
    <div class="login-brand-identity">
      <img :src="gaogeLogo" alt="" width="36" height="36" />
      <div>
        <strong>GAOGE FREE</strong>
        <span>灵感 · 科研 · 创造</span>
      </div>
    </div>

    <div class="login-brand-intro">
      <h1 id="login-brand-title">
        <span>让 AI 成为</span>
        <span>每一次突破的助力</span>
      </h1>
      <p>汇聚前沿 AI 能力，陪伴每一份灵感、研究与创造。</p>
    </div>

    <dl class="login-brand-stats" aria-label="Gaoge Free 服务规模">
      <div v-for="stat in loginServiceStats" :key="stat.label">
        <dt>{{ stat.label }}</dt>
        <dd>{{ stat.value }}</dd>
      </div>
    </dl>

    <section class="login-brand-customers" aria-labelledby="login-customer-title">
      <header class="login-customer-heading">
        <h2 id="login-customer-title">致力服务好每一位用户</h2>
      </header>
      <div
        id="login-customer-wall"
        class="login-customer-wall"
        role="region"
        aria-label="高校与企业用户标识，持续循环滚动展示"
        aria-live="off"
      >
        <div v-for="(row, rowIndex) in loginCustomerRows" :key="rowIndex" class="login-customer-row">
          <div :class="['login-customer-track', { 'is-reversed': rowIndex % 2 === 1 }]">
            <ul
              v-for="copyIndex in [0, 1]"
              :key="copyIndex"
              class="login-customer-group"
              :aria-hidden="copyIndex === 1 ? true : undefined"
            >
              <li
                v-for="customer in row"
                :key="customer.id"
                class="login-customer-card"
                :title="customer.legalName"
              >
                <span :class="['login-customer-logo', `kind-${customer.kind}`]">
                  <img :src="customer.logo" alt="" decoding="async" />
                </span>
                <span class="login-customer-name">{{ customer.name }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.login-brand-panel {
  --login-customer-card-height: 82px;
  display: flex;
  flex-direction: column;
  gap: 27px;
  min-width: 0;
  padding: 8px 0;
  color: #f3f1ec;
}

.login-brand-identity {
  display: flex;
  align-items: center;
  gap: 11px;
}

.login-brand-identity > img {
  flex: 0 0 auto;
  border: 1px solid rgba(214, 190, 144, 0.19);
  border-radius: 11px;
  object-fit: cover;
}

.login-brand-identity > div {
  display: grid;
  gap: 3px;
}

.login-brand-identity strong {
  color: #eae5dc;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.13em;
  line-height: 1.2;
}

.login-brand-identity span {
  color: #8d8982;
  font-size: 10px;
  letter-spacing: 0.14em;
}

.login-brand-intro h1 {
  display: grid;
  gap: 4px;
  margin: 0;
  font-size: clamp(34px, 3.5vw, 46px);
  font-weight: 650;
  letter-spacing: -0.04em;
  line-height: 1.25;
}

.login-brand-intro h1 > span:last-child {
  color: #d5c3a3;
}

.login-brand-intro p {
  margin: 17px 0 0;
  color: #96928b;
  font-size: 13px;
  font-weight: 400;
  letter-spacing: 0.035em;
  line-height: 1.8;
}

.login-brand-stats {
  display: flex;
  align-items: center;
  gap: 0;
  margin: 0;
}

.login-brand-stats > div {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding-right: 45px;
}

.login-brand-stats > div + div {
  border-left: 1px solid rgba(211, 193, 163, 0.16);
  padding-right: 0;
  padding-left: 45px;
}

.login-brand-stats dd {
  order: -1;
  margin: 0;
  color: #f2ece1;
  font-size: 37px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.045em;
  line-height: 1;
}

.login-brand-stats dt {
  color: #8e8a83;
  font-size: 11px;
  letter-spacing: 0.08em;
  line-height: 1.4;
}

.login-brand-customers {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding-top: 3px;
}

.login-customer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 26px;
}

.login-brand-customers h2 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  color: #9c968b;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.09em;
  line-height: 1.5;
}

.login-brand-customers h2::before {
  width: 17px;
  height: 1px;
  background: #8f7a57;
  content: '';
}

.login-customer-wall {
  display: grid;
  grid-auto-rows: var(--login-customer-card-height);
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  border-radius: 10px;
  padding: 2px 0;
  mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent);
}

.login-customer-row {
  min-width: 0;
  overflow: hidden;
}

.login-customer-track {
  display: flex;
  width: max-content;
  animation: login-customers-slide 48s linear infinite;
  will-change: transform;
}

.login-customer-track.is-reversed {
  animation-direction: reverse;
  animation-duration: 53s;
}

.login-customer-row:nth-child(3) .login-customer-track {
  animation-duration: 44s;
}

.login-customer-group {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: 10px;
  margin: 0;
  padding: 0 10px 0 0;
  list-style: none;
}

.login-customer-card {
  display: flex;
  flex: 0 0 138px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 138px;
  height: var(--login-customer-card-height);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.17);
  border-radius: 10px;
  padding: 8px 10px;
  background: #eeece7;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
}

.login-customer-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 39px;
}

.login-customer-logo img {
  display: block;
  max-width: 108px;
  max-height: 39px;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.login-customer-name {
  max-width: 100%;
  overflow: hidden;
  color: #5f5b54;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.015em;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes login-customers-slide {
  to {
    transform: translateX(-50%);
  }
}

@media (max-height: 740px) and (min-width: 961px) {
  .login-brand-panel {
    --login-customer-card-height: 76px;
    gap: 21px;
  }

  .login-brand-intro h1 {
    font-size: 40px;
  }

  .login-brand-intro p {
    margin-top: 13px;
  }

  .login-customer-logo,
  .login-customer-logo img {
    max-height: 35px;
  }
}

@media (max-width: 960px) {
  .login-brand-panel {
    gap: 25px;
    width: 100%;
    max-width: 620px;
    margin: 0 auto;
  }

  .login-brand-intro h1 {
    font-size: clamp(30px, 5.6vw, 42px);
  }
}

@media (max-width: 480px) {
  .login-brand-panel {
    gap: 23px;
  }

  .login-brand-intro p {
    max-width: 27em;
    font-size: 12px;
  }

  .login-brand-stats > div {
    padding-right: 28px;
  }

  .login-brand-stats > div + div {
    padding-left: 28px;
  }

  .login-brand-stats dd {
    font-size: 32px;
  }

  .login-customer-card {
    flex-basis: 124px;
    width: 124px;
  }
}

/* Keep the requested marquee and its three-row geometry in every motion mode.
   Slower playback preserves the continuous motion without expanding the grid. */
@media (prefers-reduced-motion: reduce) {
  .login-customer-track {
    animation-duration: 80s;
  }

  .login-customer-track.is-reversed {
    animation-duration: 88s;
  }

  .login-customer-row:nth-child(3) .login-customer-track {
    animation-duration: 76s;
  }
}
</style>
