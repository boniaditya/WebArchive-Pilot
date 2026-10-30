const form = document.getElementById('requestForm');
const fromEmailInput = document.getElementById('fromEmail');
const titleInput = document.getElementById('requestTitle');
const descriptionInput = document.getElementById('requestDescription');
const sourceUrlInput = document.getElementById('sourceUrl');
const imageDrop = document.getElementById('imageDrop');
const imageInput = document.getElementById('imageInput');
const chooseImage = document.getElementById('chooseImage');
const previewWrap = document.getElementById('previewWrap');
const imagePreview = document.getElementById('imagePreview');
const removeImage = document.getElementById('removeImage');
const sendRequest = document.getElementById('sendRequest');
const status = document.getElementById('status');
let attachedImage = null;
let previewUrl = '';

sourceUrlInput.value = new URLSearchParams(location.search).get('sourceUrl') || '';
chooseImage.onclick = () => imageInput.click();
imageInput.onchange = () => setImage(imageInput.files[0]);
removeImage.onclick = clearImage;

document.addEventListener('paste', (event) => {
  const image = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'))?.getAsFile();
  if (!image) return;
  event.preventDefault();
  setImage(image);
});

for (const eventName of ['dragenter', 'dragover']) imageDrop.addEventListener(eventName, (event) => { event.preventDefault(); imageDrop.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) imageDrop.addEventListener(eventName, (event) => { event.preventDefault(); imageDrop.classList.remove('dragging'); });
imageDrop.addEventListener('drop', (event) => setImage([...event.dataTransfer.files].find((file) => file.type.startsWith('image/'))));
imageDrop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); imageInput.click(); } });

function setImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { status.textContent = 'Choose or paste an image file.'; return; }
  if (file.size > 10 * 1024 * 1024) { status.textContent = 'The image must be smaller than 10 MB.'; return; }
  clearPreviewUrl();
  attachedImage = new File([file], normaliseImageName(file.name, file.type), { type: file.type, lastModified: file.lastModified || Date.now() });
  previewUrl = URL.createObjectURL(attachedImage);
  imagePreview.src = previewUrl;
  previewWrap.classList.add('visible');
  imageDrop.hidden = true;
  status.textContent = `${attachedImage.name} ready to attach.`;
}

function clearImage() {
  clearPreviewUrl();
  attachedImage = null;
  imageInput.value = '';
  imagePreview.removeAttribute('src');
  previewWrap.classList.remove('visible');
  imageDrop.hidden = false;
  status.textContent = '';
}

function clearPreviewUrl() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
}

function normaliseImageName(name, type) {
  if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) return name.replace(/[^a-z0-9._-]+/gi, '_');
  const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png';
  return `feature-request-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  sendRequest.disabled = true;
  status.textContent = 'Sending feature request…';
  const manifest = chrome.runtime.getManifest();
  const payload = new FormData();
  payload.set('email', fromEmailInput.value.trim());
  payload.set('_replyto', fromEmailInput.value.trim());
  payload.set('_subject', `[WebArchive Pilot feature request] ${titleInput.value.trim()}`);
  payload.set('feature_title', titleInput.value.trim());
  payload.set('message', descriptionInput.value.trim());
  payload.set('related_page', sourceUrlInput.value.trim() || 'Not provided');
  payload.set('extension_version', manifest.version);
  payload.set('_template', 'table');
  payload.set('_captcha', 'false');
  if (attachedImage) payload.set('attachment', attachedImage, attachedImage.name);
  try {
    const response = await fetch('https://formsubmit.co/ajax/boni.aditya@gmail.com', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: payload,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false || result.success === 'false') {
      throw new Error(result.message || `Delivery failed (${response.status}).`);
    }
    const preservedUrl = sourceUrlInput.value;
    form.reset();
    clearImage();
    sourceUrlInput.value = preservedUrl;
    status.textContent = 'Feature request sent successfully.';
  } catch (error) {
    status.textContent = `Could not send the request: ${error?.message || error}`;
  } finally {
    sendRequest.disabled = false;
  }
});
