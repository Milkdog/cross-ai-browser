console.log('rename-dialog.js loaded');

// Get data from query params
const params = new URLSearchParams(window.location.search);
const tabId = params.get('tabId');
const currentName = decodeURIComponent(params.get('currentName') || '');

console.log('Rename dialog params:', { tabId, currentName });

const input = document.getElementById('name-input');

// Set the current name in the input
if (currentName) {
  input.value = currentName;
}

// Focus and select after a brief delay
setTimeout(() => {
  input.focus();
  input.select();
}, 100);

function submit() {
  const newName = input.value.trim();
  console.log('Submit:', { tabId, newName });
  if (newName && tabId) {
    window.electronAPI.submitRename(tabId, newName);
  } else {
    window.electronAPI.cancelRename();
  }
}

function cancel() {
  console.log('Cancel');
  window.electronAPI.cancelRename();
}

document.getElementById('confirm-btn').addEventListener('click', submit);
document.getElementById('cancel-btn').addEventListener('click', cancel);

// Click outside modal to cancel
document.getElementById('backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'backdrop') {
    cancel();
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  }
  if (e.key === 'Escape') {
    cancel();
  }
});
