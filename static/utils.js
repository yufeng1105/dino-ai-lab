function showToast(message, type='error') {
    let alertBox = document.getElementById('customToastAlert');
    if (!alertBox) {
        alertBox = document.createElement('div');
        alertBox.id = 'customToastAlert';
        alertBox.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); color:white; padding:10px 20px; border-radius:5px; z-index:99999; opacity:0; transition:opacity 0.3s; font-weight:bold; box-shadow:0 4px 6px rgba(0,0,0,0.2); pointer-events:none; font-size:14px;';
        document.body.appendChild(alertBox);
    }
    
    if (type === 'success') {
        alertBox.style.background = '#2ecc71';
    } else if (type === 'warning') {
        alertBox.style.background = '#f39c12';
    } else {
        alertBox.style.background = '#e74c3c';
    }
    
    alertBox.innerText = message;
    
    // trigger reflow
    void alertBox.offsetWidth;
    alertBox.style.opacity = '1';
    if (window.customToastTimeout) clearTimeout(window.customToastTimeout);
    window.customToastTimeout = setTimeout(() => { alertBox.style.opacity = '0'; }, 3000);
}
