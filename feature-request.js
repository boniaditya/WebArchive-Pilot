const requestForm = document.getElementById('requestForm');
const featureTitle = document.getElementById('featureTitle');
const featureDetails = document.getElementById('featureDetails');
const requestStatus = document.getElementById('status');
const imageDropzone = document.getElementById('imageDropzone');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const imageName = document.getElementById('imageName');
let selectedImage = null;

function setImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    requestStatus.textContent = 'Please choose an image file.';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    requestStatus.textContent = 'Please choose an image smaller than 10 MB.';
    return;
  }
  selectedImage = file;
  imagePreview.src = URL.createObjectURL(file);
  imagePreview.style.display = 'block';
  imageName.textContent = `${file.name || 'Pasted image'} · ${(file.size / 1024).toFixed(0)} KB`;
  requestStatus.textContent = '';
}

imageInput.addEventListener('change', () => setImage(imageInput.files[0]));
imageDropzone.addEventListener('dragover', (event) => { event.preventDefault(); imageDropzone.classList.add('dragover'); });
imageDropzone.addEventListener('dragleave', () => imageDropzone.classList.remove('dragover'));
imageDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  imageDropzone.classList.remove('dragover');
  setImage(event.dataTransfer.files[0]);
});
imageDropzone.addEventListener('paste', (event) => {
  const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith('image/'));
  if (item) setImage(item.getAsFile());
});

requestForm.addEventListener('submit', (event) => {
  event.preventDefault();
  featureTitle.setCustomValidity(featureTitle.value.trim() ? '' : 'Please enter a feature title.');
  featureDetails.setCustomValidity(featureDetails.value.trim() ? '' : 'Please describe your feature.');
  if (!requestForm.reportValidity()) return;

  const version = chrome.runtime.getManifest().version;
  const subject = `WebArchive Pilot feature request: ${featureTitle.value.trim()}`;
  const body = `${featureDetails.value.trim()}\r\n\r\n---\r\nWebArchive Pilot version: ${version}${selectedImage ? `\r\nImage: ${selectedImage.name || 'pasted-image'}` : ''}`;
  const mailto = `mailto:boni.aditya@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (selectedImage && navigator.share && navigator.canShare && navigator.canShare({ files: [selectedImage] })) {
    navigator.share({ title: subject, text: body, files: [selectedImage] })
      .then(() => { requestStatus.textContent = 'Your request and image are ready to share. Choose your email app and send it to boni.aditya@gmail.com.'; })
      .catch(() => { window.location.href = mailto; });
  } else {
    if (selectedImage) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(selectedImage);
      link.download = selectedImage.name || 'feature-request-image';
      link.click();
    }
    window.location.href = mailto;
    requestStatus.textContent = selectedImage
      ? 'Your email draft is ready. The image was downloaded so you can attach it before sending.'
      : 'Your request is ready in your email app. Review it and press Send.';
  }
});

for (const field of [featureTitle, featureDetails]) {
  field.addEventListener('input', () => field.setCustomValidity(''));
}
