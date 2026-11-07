$(document).ready(function () {
    if (localStorage.getItem("sideBarToggleStatus") === 'false'  || localStorage.getItem("sideBarToggleStatus") === null) {
        var sidebar = document.getElementById("accordionSidebar");
        sidebar.classList.remove('collapse');
    } 
});
