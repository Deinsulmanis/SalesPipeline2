/* ============================
   SCALELAB AI — JAVASCRIPT
   ============================ */

// LOADER
(function () {
  const loader = document.getElementById('loader');
  document.body.style.overflow = 'hidden';

  // Phase 2: text slides in after hex is fully drawn
  setTimeout(() => loader.classList.add('phase2'), 1800);

  // Exit: fade overlay out
  setTimeout(() => {
    loader.classList.add('exit');
    document.body.style.overflow = '';
  }, 2700);

  // Remove from DOM entirely after fade
  setTimeout(() => loader.remove(), 3400);
})();

// NAV SCROLL + SECTION-AWARE COLOR
const nav = document.getElementById('nav');

const sectionMap = [
  { selector: '.cta-strip',    cls: 'on-cta'  },
  { selector: '.section--alt', cls: 'on-alt'  },
];

function updateNav() {
  const scrolled = window.scrollY > 20;
  nav.classList.toggle('scrolled', scrolled);

  // Detect which section midpoint of the nav is over
  const navBottom = nav.getBoundingClientRect().bottom + window.scrollY;
  let matched = null;

  for (const { selector, cls } of sectionMap) {
    document.querySelectorAll(selector).forEach(el => {
      const top = el.offsetTop;
      const bot = top + el.offsetHeight;
      if (navBottom >= top && navBottom <= bot) matched = cls;
    });
  }

  nav.classList.toggle('on-alt', matched === 'on-alt');
  nav.classList.toggle('on-cta', matched === 'on-cta');
}

window.addEventListener('scroll', updateNav, { passive: true });
updateNav(); // run once on load

// MOBILE MENU TOGGLE
const navToggle = document.getElementById('navToggle');
const navLinks = document.querySelector('.nav-links');
navToggle.addEventListener('click', () => {
  const open = navLinks.style.display === 'flex';
  navLinks.style.cssText = open
    ? ''
    : 'display:flex;flex-direction:column;position:fixed;top:80px;left:0;right:0;background:rgba(2,13,24,0.97);backdrop-filter:blur(16px);padding:24px;gap:24px;border-bottom:1px solid rgba(0,212,255,0.12);';
});

// Close mobile nav on link click
document.querySelectorAll('.nav-links a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.style.cssText = '';
  });
});

// SCROLL REVEAL
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

// Auto-add reveal to sections
document.querySelectorAll([
  '.service-card',
  '.step',
  '.result-card',
  '.contact-wrap > *',
  '.section-header',
  '.terminal-wrap',
  '.steps',
].join(',')).forEach((el, i) => {
  el.classList.add('reveal');
  if (i % 3 === 1) el.classList.add('reveal-delay-1');
  if (i % 3 === 2) el.classList.add('reveal-delay-2');
  revealObserver.observe(el);
});

// LIVE TIME UPDATE IN TERMINAL
function updateLiveTime() {
  const el = document.getElementById('liveTime');
  if (!el) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  el.textContent = `${h}:${m}:${s}`;
}
updateLiveTime();
setInterval(updateLiveTime, 1000);

// CONTACT FORM
const form = document.getElementById('contactForm');
const success = document.getElementById('formSuccess');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  btn.textContent = 'Sending...';
  btn.disabled = true;
  btn.style.opacity = '0.7';

  // Simulate send (replace with real API call)
  setTimeout(() => {
    form.querySelectorAll('input, textarea').forEach(el => el.value = '');
    btn.textContent = 'Send Message →';
    btn.disabled = false;
    btn.style.opacity = '1';
    success.classList.add('visible');
    setTimeout(() => success.classList.remove('visible'), 6000);
  }, 1200);
});

// SMOOTH SCROLL — account for nav height
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// COUNTER ANIMATION for stat numbers
function animateCounters() {
  const stats = document.querySelectorAll('.stat-num, .result-num');
  stats.forEach(el => {
    const text = el.textContent.trim();
    const num = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(num) || num === 0) return;

    const prefix = text.match(/^[^0-9]*/)?.[0] || '';
    const suffix = text.match(/[^0-9.]+$/)?.[0] || '';
    const duration = 1200;
    const start = performance.now();

    function update(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const current = num * ease;
      const display = num < 10 ? current.toFixed(1) : Math.round(current);
      el.textContent = prefix + display + suffix;
      if (t < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
  });
}

// Trigger counter on section visibility
const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounters();
      counterObserver.disconnect();
    }
  });
}, { threshold: 0.3 });

const resultsSection = document.querySelector('.results-grid');
if (resultsSection) counterObserver.observe(resultsSection);

// HERO CUBE PARALLAX (subtle)
const heroCube = document.querySelector('.hero-cube');
if (heroCube) {
  window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 12;
    const y = (e.clientY / window.innerHeight - 0.5) * 8;
    heroCube.style.transform = `translateY(-50%) translate(${x}px, ${y}px)`;
  }, { passive: true });
}
