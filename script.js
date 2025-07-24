document.addEventListener('DOMContentLoaded', function () {
    // PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE
    // MAKE SURE THIS IS THE LATEST DEPLOYMENT URL FOR YOUR Code.gs
    const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzJKwh2MncH1PXoG7Yky9ClmvoOuH4kQXn3fTXsiVLoJ7JwFL1fxw4sCu0eRhLxNXEq/exec'; // Your deployed web app URL

    // --- Global State ---
    let timeChart, typeChart;
    const allReports = []; // Stores all fetched reports
    let provinceLayer = null; // Initialize as null
    let dsdLayer = null; // Initialize as null

    let sensitiveLayersReady = false; // Flag to indicate if sensitive layers are ready

    // Stores Leaflet GeoJSON layer objects for proximity analysis
    const geojsonLayers = {
        primarySchools: null,
        hospitals: null,
        schools: null,
        touristSpots: null,
        lakes: null,
        rivers: null,
        office: null // Add office layer
    };

    let isAdminMode = false;

    // --- UI Elements ---
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    const adminLoginModal = new bootstrap.Modal(document.getElementById('adminLoginModal'));
    const adminPasswordInput = document.getElementById('adminPassword');
    const adminLoginSubmitBtn = document.getElementById('adminLoginSubmitBtn');
    const startReportBtn = document.getElementById('startReportBtn');
    const reportModal = new bootstrap.Modal(document.getElementById('reportModal'));
    // const locateBtn = document.getElementById('locate-btn'); // REMOVED: No longer directly get button ref, it's created dynamically

    // References for new modal input fields
    const dsdNameInput = document.getElementById('dsdName');
    const responsibleOfficeNameInput = document.getElementById('responsibleOfficeName');
    const responsibleOfficePhoneInput = document.getElementById('responsibleOfficePhone');

    const riskLevelInput = document.getElementById('riskLevel');
    const proximityAlertsDiv = document.getElementById('proximityAlerts');
    const proximityListUl = document.getElementById('proximityList');
    const liveLocationWarning = document.getElementById('liveLocationWarning');
    const loadingSpinner = document.getElementById('loadingSpinner');


    // --- Map Initialization ---
    const baseMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });
    const map = L.map('map', { zoomControl: true, layers: [baseMap] });
    map.setView([7.8731, 80.7718], 8); // Default view for Sri Lanka

    const clusterGrp = L.markerClusterGroup({
        spiderfyOnMaxZoom: true, showCoverageOnHover: false, zoomToBoundsOnClick: true
    });
    map.addLayer(clusterGrp); // Always show dumping sites

    // --- Core Functions ---
    function showToast(message, isError = false) {
        const toastContainer = document.getElementById('toast-container');
        toastContainer.textContent = message;
        toastContainer.style.backgroundColor = isError ? '#be123c' : '#1e293b';
        toastContainer.classList.add('show');
        setTimeout(() => toastContainer.classList.remove('show'), 4000);
    }

    function showLoadingSpinner() {
        loadingSpinner.style.display = 'flex'; // Display immediately
    }

    function hideLoadingSpinner() {
        loadingSpinner.style.display = 'none';
    }

    function calculateRisk(lat, lng) {
        console.log("calculateRisk called for lat:", lat, "lng:", lng); // DEBUG
        const point = turf.point([lng, lat]); // turf.js expects [longitude, latitude]

        const buffers = {
            primarySchools: { layer: geojsonLayers.primarySchools, distance: 100, unit: 'meters', risk: 'Critical', message: 'Primary School' },
            hospitals: { layer: geojsonLayers.hospitals, distance: 250, unit: 'meters', risk: 'Critical', message: 'Hospital' },
            schools: { layer: geojsonLayers.schools, distance: 300, unit: 'meters', risk: 'High', message: 'General School' },
            touristSpots: { layer: geojsonLayers.touristSpots, distance: 500, unit: 'meters', risk: 'High', message: 'Tourist Spot' },
            lakes: { layer: geojsonLayers.lakes, distance: 150, unit: 'meters', risk: 'Medium', message: 'Lake' },
            rivers: { layer: geojsonLayers.rivers, distance: 150, unit: 'meters', risk: 'Medium', message: 'River' }
        };

        let highestRiskLevel = "Low";
        const proximityMessages = [];

        const prioritizedRisks = ['Critical', 'High', 'Medium', 'Low'];

        for (const currentRiskPriority of prioritizedRisks) {
            for (const key in buffers) {
                const buffer = buffers[key];
                
                if (buffer.layer) {
                    const features = buffer.layer.toGeoJSON();
                    
                    if (features.features && features.features.length > 0) {
                        for (const feature of features.features) {
                            if (!feature.geometry || !feature.geometry.coordinates) {
                                console.warn(`Skipping invalid or empty feature in ${key}:`, feature); // DEBUG
                                continue;
                            }

                            try {
                                const bufferedFeature = turf.buffer(feature, buffer.distance, { units: buffer.unit });
                                if (turf.booleanPointInPolygon(point, bufferedFeature)) {
                                    if (prioritizedRisks.indexOf(buffer.risk) < prioritizedRisks.indexOf(highestRiskLevel)) {
                                        highestRiskLevel = buffer.risk;
                                    }
                                    const message = `Near ${buffer.message} (${buffer.distance}m, ${buffer.risk} Risk)`;
                                    if (!proximityMessages.includes(message)) {
                                        proximityMessages.push(message);
                                    }
                                    console.log(`Point is within ${buffer.distance}m of a ${key} feature. Adding message: "${message}"`); // DEBUG
                                }
                            } catch (e) {
                                console.error(`Turf.js error processing feature in ${key} - possible invalid geometry:`, feature, e); // DEBUG
                            }
                        }
                    } else {
                        console.log(`No features found in ${key} layer, or layer might be empty.`); // DEBUG
                    }
                }
            }
        }
        
        if (proximityMessages.length === 0) {
            proximityMessages.push("No specific sensitive areas detected within buffer zones. (Low Risk)");
            highestRiskLevel = "Low";
        } else {
            proximityMessages.sort();
        }

        console.log("Calculated Risk Result:", { highestRiskLevel, proximityMessages }); // DEBUG
        return { riskLevel: highestRiskLevel, proximityMessages: proximityMessages };
    }


    function addMarker(report) {
        let iconClass = 'dumping-icon';
        if (report.status === 'Under Investigation') {
            iconClass = 'investigating-icon';
        }

        const icon = L.divIcon({
            className: `custom-icon ${iconClass}`,
            html: '<i class="fa-solid fa-trash-can"></i>',
        });
        
        let popupContent = `<strong>${report.wtype || 'N/A'} (${report.wsize || 'N/A'})</strong><br>
            <span class="badge bg-secondary">${report.status || 'N/A'}</span>
            <p class="my-1">${report.description || 'No description provided.'}</p>
            <small class="text-muted">DSD: ${report.dsdname || 'N/A'}</small><br>
            <small class="text-muted">Office: ${report.responsibleoffice || 'N/A'}</small><br>
            <small class="text-muted">Phone: ${report.responsibleofficephone || 'N/A'}</small>`;

        if (report.risklevel) {
            let riskBadgeClass = '';
            if (report.risklevel === 'Critical') riskBadgeClass = 'bg-danger';
            else if (report.risklevel === 'High') riskBadgeClass = 'bg-warning text-dark';
            else if (report.risklevel === 'Medium') riskBadgeClass = 'bg-info';
            else riskBadgeClass = 'bg-success';
            popupContent += `<p class="mt-2 mb-0 small fst-italic"><strong>Risk Level:</strong> <span class="badge ${riskBadgeClass}">${report.risklevel}</span></p>`;
        }


        if (report.verifiedcount && parseInt(report.verifiedcount) > 0) {
            popupContent += `<p class="mt-2 mb-0 small fst-italic"><strong>Verification Count:</strong> ${report.verifiedcount} reports</p>`;
        }
        if (report.certify) {
            popupContent += `<p class="mb-0 small fst-italic"><strong>Status:</strong> ${report.certify}</p>`;
        }
        
        if (report.verifiedcount && parseInt(report.verifiedcount) > 1) {
            popupContent += `<span class="badge bg-success mt-1"><i class="fa-solid fa-check-circle"></i> Verified Location</span>`;
        }

        if (!isAdminMode) {
            popupContent += `
                <div class="mt-2 text-center">
                    <button class="btn btn-sm btn-outline-primary" onclick="reportExistingSite('${report.lat}', '${report.lng}')">
                        <i class="fa-solid fa-flag"></i> Report This Site Again
                    </button>
                </div>
            `;
        }
        
        if (isAdminMode) {
            popupContent += `
                <div class="admin-popup-actions">
                    <small class="text-muted d-block mb-1">Official Action:</small>
                    <div class="input-group input-group-sm mb-2">
                        <label class="input-group-text" for="status-select-${report.timestamp}">Status</label>
                        <select class="form-select" id="status-select-${report.timestamp}">
                            <option value="New" ${report.status === 'New' ? 'selected' : ''}>New</option>
                            <option value="Under Investigation" ${report.status === 'Under Investigation' ? 'selected' : ''}>Under Investigation</option>
                            <option value="Action Pending" ${report.status === 'Action Pending' ? 'selected' : ''}>Action Pending</option>
                            <option value="Cleaned" ${report.status === 'Cleaned' ? 'selected' : ''}>Cleaned</option>
                        </select>
                    </div>
                    <button class="btn btn-primary btn-sm w-100" onclick="submitStatusUpdate('${report.timestamp}')">Update Status</button>
                </div>`;
        }
        
        const marker = L.marker([report.lat, report.lng], { icon }).bindPopup(popupContent);
        marker.reportData = report;
        clusterGrp.addLayer(marker);
    }
    
    function updateDashboard() {
        clusterGrp.clearLayers();

        const reportsForMap = allReports.filter(report => {
            return report.status !== 'Cleaned';
        });
        reportsForMap.forEach(addMarker);
        
        const statusCounts = allReports.reduce((acc, report) => {
            acc[report.status] = (acc[report.status] || 0) + 1;
            return acc;
        }, { "New": 0, "Under Investigation": 0, "Action Pending": 0, "Cleaned": 0 });

        document.getElementById('statNew').textContent = statusCounts['New'];
        document.getElementById('statInvestigating').textContent = statusCounts['Under Investigation'];
        document.getElementById('statCleaned').textContent = statusCounts['Cleaned'];
        updateCharts();
    }

    function updateCharts() {
        const reportsToChart = allReports;

        Chart.defaults.color = '#FFFFFF';
        Chart.defaults.font.family = 'Poppins';

        const timeCtx = document.getElementById('timeChart').getContext('2d');
        if (timeCtx) {
            if (timeChart) timeChart.destroy();
            const reportsByDate = reportsToChart.reduce((acc, report) => {
                const date = new Date(report.timestamp).toISOString().split('T')[0];
                acc[date] = (acc[date] || 0) + 1;
                return acc;
            }, {});
            const sortedDates = Object.keys(reportsByDate).sort((a, b) => new Date(a) - new Date(b));
            timeChart = new Chart(timeCtx, {
                type: 'line',
                data: {
                    labels: sortedDates.map(d => new Date(d).toLocaleDateString()),
                    datasets: [{ label: 'Reports', data: sortedDates.map(date => reportsByDate[date]), borderColor: '#0d6efd', backgroundColor: 'rgba(13, 110, 253, 0.1)', fill: true, tension: 0.1 }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    }, 
                    scales: {
                        x: { 
                            ticks: { 
                                autoSkip: true, 
                                maxRotation: 45, 
                                minRotation: 0,
                                color: 'white'
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)',
                                borderColor: 'transparent'
                            }
                        },
                        y: {
                            ticks: {
                                color: 'white'
                            },
                            grid: {
                                color: 'rgba(255, 255, 255, 0.1)',
                                borderColor: 'transparent'
                            }
                        }
                    } 
                }
            });
        }

        const typeCtx = document.getElementById('typeChart').getContext('2d');
        if (typeCtx) {
            if (typeChart) typeChart.destroy();
            const typesCount = reportsToChart.reduce((acc, report) => {
                if (report.wtype) {
                    acc[report.wtype] = (acc[report.wtype] || 0) + 1;
                }
                return acc;
            }, {});
            
            const labels = Object.keys(typesCount).filter(key => key && key !== 'undefined');
            const data = labels.map(key => typesCount[key]);

            typeChart = new Chart(typeCtx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{ 
                        data: data, 
                        backgroundColor: ['#0d6efd', '#6c757d', '#198754', '#ffc107', '#dc3545', '#0dcaf0'],
                        borderColor: '#374151',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { 
                                padding: 10, 
                                boxWidth: 12,
                                color: 'white'
                            } 
                        } 
                    } 
                }
            });
        }
    }

    window.submitStatusUpdate = async (timestamp) => {
        if (!isAdminMode) return;
        const newStatus = document.getElementById(`status-select-${timestamp}`).value;
        showToast("Updating status...");
        const formData = new FormData();
        formData.append('action', 'updateStatus');
        formData.append('timestamp', timestamp);
        formData.append('status', newStatus);

        try {
            const response = await fetch(SCRIPT_URL, { method: 'POST', body: formData }).then(res => res.json());
            if (response.result === 'success') {
                const reportIndex = allReports.findIndex(r => r.timestamp === timestamp);
                if (reportIndex > -1) {
                    allReports[reportIndex].status = newStatus;
                }
                updateDashboard();
                showToast("Status updated successfully!");
                map.closePopup();
            } else { throw new Error(response.message); }
        } catch (error) { showToast(`Error: ${error.message}`, true); }
    };
    
    window.reportExistingSite = async (lat, lng) => {
        map.closePopup();
        showToast("Reporting existing site...");
        
        const formData = new FormData();
        formData.append('action', 'incrementVerifiedCount');
        formData.append('lat', parseFloat(lat));
        formData.append('lng', parseFloat(lng));

        try {
            const response = await fetch(SCRIPT_URL, { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if (data.result === 'success') {
                const tolerance = 0.00001;
                const existingReport = allReports.find(r =>
                    Math.abs(r.lat - parseFloat(lat)) < tolerance && Math.abs(r.lng - parseFloat(lng)) < tolerance
                );
                if (existingReport) {
                    existingReport.verifiedcount = data.newCount;
                    existingReport.certify = (data.newCount >= 2) ? "Verified by users" : "";
                }
                updateDashboard();
                showToast("Your record has been sent. Thank you!");
            } else {
                throw new Error(data.message || 'Unknown error while reporting existing site');
            }
        } catch (error) {
            showToast('Error reporting existing site: ' + error.message, true);
        } finally {
            map.closePopup();
        }
    };

    function enterAdminMode() {
        isAdminMode = true;
        adminLoginBtn.classList.replace('btn-outline-secondary', 'btn-success');
        adminLoginBtn.innerHTML = '<i class="fa-solid fa-user-check"></i> Admin Mode Active';
        adminLoginModal.hide();
        adminPasswordInput.value = '';
        showToast("Admin mode activated.");
        updateDashboard();
    }

    function exitAdminMode() {
        isAdminMode = false;
        adminLoginBtn.classList.replace('btn-success', 'btn-outline-secondary');
        adminLoginBtn.innerHTML = '<i class="fa-solid fa-user-shield"></i> Officer Login';
        showToast("Admin mode deactivated.");
        updateDashboard();
    }

    // --- Event Listeners ---
    adminLoginBtn.addEventListener('click', () => {
        if (isAdminMode) {
            if (confirm("Are you sure you want to log out?")) exitAdminMode();
        } else {
            adminLoginModal.show();
        }
    });

    adminLoginSubmitBtn.addEventListener('click', () => {
        if (adminPasswordInput.value === '1234') enterAdminMode();
        else alert("Incorrect password.");
    });
    
    startReportBtn.addEventListener('click', () => {
        showToast("Click on the map to place your new report.");
    });

    // map.on('click') remains async because it uses await new Promise
    map.on('click', async e => {
        showLoadingSpinner(); // Show loading spinner immediately
        
        try {
            // Add a small delay to ensure spinner appears visually before heavy calculations
            await new Promise(resolve => setTimeout(resolve, 50)); 

            // Prevent map click from triggering if a marker or other interactive element was clicked
            if (e.originalEvent.target.classList.contains('leaflet-interactive') || e.originalEvent.target.closest('.leaflet-marker-icon') || e.originalEvent.target.closest('.leaflet-control')) {
                 console.log("Clicked on a Leaflet interactive element, marker, or control. Ignoring map click for reporting.");
                 return;
            }
            
            console.log("Current state of sensitiveLayersReady:", sensitiveLayersReady); // DEBUG

            if (!sensitiveLayersReady) {
                showToast("Map data is still loading. Please wait a moment before reporting a new site.", true);
                console.warn("Sensitive layers not yet ready for risk calculation. Click ignored.");
                return; 
            }

            if (!provinceLayer || !dsdLayer) {
                showToast("Map boundary data is not yet loaded. Please wait a moment and try again.", true);
                console.error("Boundary layers (provinceLayer or dsdLayer) are not loaded yet. Skipping pointInLayer check.");
                return;
            }

            console.log("Attempting point-in-layer check for LatLng:", e.latlng.lat, e.latlng.lng); // DEBUG
            console.log("State of provinceLayer before check:", provinceLayer); // DEBUG

            let pointInProvince = null;
            try {
                pointInProvince = leafletPip.pointInLayer(e.latlng, provinceLayer, true);
                console.log("leafletPip.pointInLayer result (province):", pointInProvince); // DEBUG
            } catch (error) {
                console.error("Error during leafletPip.pointInLayer for provinceLayer:", error); // DEBUG
                showToast("An error occurred checking the province boundary. Please try again or check console.", true);
                return;
            }
            
            if (pointInProvince && pointInProvince.length > 0) {
                let containingDsd = null;
                try {
                    containingDsd = leafletPip.pointInLayer(e.latlng, dsdLayer, true);
                    console.log("leafletPip.pointInLayer result (DSD):", containingDsd); // DEBUG
                } catch (error) {
                    console.error("Error during leafletPip.pointInLayer for dsdLayer:", error); // DEBUG
                    showToast("An error occurred checking DSD boundary. Proceeding with N/A DSD name.", true);
                }
                
                const dsdName = (containingDsd && containingDsd.length > 0) ? containingDsd[0].feature.properties.DSD_N : 'N/A';
                dsdNameInput.value = dsdName; // Set DSD Name
                
                // Find nearest office and populate fields
                let officeName = 'N/A';
                let officePhone = 'N/A';
                if (geojsonLayers.office && geojsonLayers.office.toGeoJSON().features.length > 0) {
                    const clickedPoint = turf.point([e.latlng.lng, e.latlng.lat]);
                    const allOffices = geojsonLayers.office.toGeoJSON();
                    const nearestOffice = turf.nearestPoint(clickedPoint, allOffices);

                    // Define a search radius (e.g., 10km) to consider an office "nearby"
                    const searchRadiusKm = 10; 
                    const distanceToOffice = turf.distance(clickedPoint, nearestOffice, { units: 'kilometers' });

                    if (distanceToOffice <= searchRadiusKm) {
                        officeName = nearestOffice.properties.title || 'N/A';
                        // Ensures phone is a string, even if null/undefined in GeoJSON.
                        // The formatting for Google Sheet is handled in code.gs.
                        officePhone = String(nearestOffice.properties.phone || ''); 
                    } else {
                        console.log(`No office found within ${searchRadiusKm}km radius.`); // DEBUG
                    }
                } else {
                    console.warn("Office GeoJSON layer not loaded or empty. Cannot find responsible office."); // DEBUG
                }
                responsibleOfficeNameInput.value = officeName;
                responsibleOfficePhoneInput.value = officePhone;

                console.log("State of geojsonLayers before calculateRisk:", geojsonLayers); // DEBUG
                for (const key in geojsonLayers) {
                    if (geojsonLayers[key]) {
                        console.log(`geojsonLayers.${key} is defined and contains data.`); // DEBUG
                    } else {
                        console.warn(`geojsonLayers.${key} is NULL or undefined. Risk calculation for this layer will not work.`); // DEBUG
                    }
                }

                // Calculate Risk Level and get Proximity Messages
                const riskCalculationResult = calculateRisk(e.latlng.lat, e.latlng.lng);
                const calculatedRisk = riskCalculationResult.riskLevel;
                const proximityMessages = riskCalculationResult.proximityMessages;

                riskLevelInput.value = calculatedRisk;
                console.log("Set Calculated Risk Level in modal input to:", calculatedRisk); // DEBUG
                console.log("Risk level input value after setting:", riskLevelInput.value); // DEBUG

                // Display proximity messages in the modal
                proximityListUl.innerHTML = '';
                if (proximityMessages.length > 0) {
                    proximityAlertsDiv.style.display = 'block';
                    proximityMessages.forEach(msg => {
                        const li = document.createElement('li');
                        li.textContent = msg;
                        proximityListUl.appendChild(li);
                    });
                } else {
                    proximityAlertsDiv.style.display = 'none';
                }

                document.getElementById('lat').value = e.latlng.lat.toFixed(6);
                document.getElementById('lng').value = e.latlng.lng.toFixed(6);
                
                reportModal.show();

            } else {
                showToast("Please click inside the North Western Province boundary to report.");
                console.log("Click outside province boundary."); // DEBUG
            }
        } finally { // Ensure spinner is hidden in all cases
            hideLoadingSpinner();
        }
    });

    repForm.addEventListener('submit', async e => {
        e.preventDefault();
        if (!repForm.checkValidity()) {
            repForm.classList.add('was-validated');
            return;
        }
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Submitting...';

        const photoFile = document.getElementById('photo').files[0];
        const formData = new FormData(repForm);
        
        // Append all new fields to formData
        formData.append('dsdName', dsdNameInput.value);
        formData.append('responsibleOffice', responsibleOfficeNameInput.value);
        formData.append('responsibleOfficePhone', responsibleOfficePhoneInput.value);
        formData.append('riskLevel', riskLevelInput.value);

        if (photoFile && photoFile.size > 0) {
            const reader = new FileReader();
            reader.onload = (event) => {
                formData.append('photoBase64', event.target.result.split(',')[1]);
                formData.append('photoName', photoFile.name);
                formData.delete('photo');
                submitNewReportRequest(formData);
            };
            reader.readAsDataURL(photoFile);
        } else {
            submitNewReportRequest(formData);
        }
    });

    async function submitNewReportRequest(formData) {
        const optimisticReport = {
            status: 'New', 
            wtype: formData.get('wType'), 
            wsize: formData.get('wSize'), 
            description: formData.get('desc'), 
            lat: parseFloat(formData.get('lat')), 
            lng: parseFloat(formData.get('lng')), 
            timestamp: new Date().toISOString(), 
            photourl: '', 
            authority: formData.get('dsdName'), // Use dsdName as the primary 'authority' for existing column
            responsibleOffice: formData.get('responsibleOffice'),
            responsibleOfficePhone: formData.get('responsibleOfficePhone'),
            risklevel: formData.get('riskLevel'),
            verifiedcount: 1, 
            certify: '' 
        };
        allReports.push(optimisticReport);
        updateDashboard();
        console.log("Optimistic report added:", optimisticReport); // DEBUG

        try {
            const response = await fetch(SCRIPT_URL, { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if(data.result === 'success') {
                const reportIndex = allReports.findIndex(r => r.timestamp === optimisticReport.timestamp);
                if (reportIndex > -1) {
                    allReports[reportIndex].timestamp = data.timestamp;
                    allReports[reportIndex].photourl = data.photoUrl;
                }
                updateDashboard();
                showToast("Thank you for helping to identify illegal dumping sites!");
            } else { throw new Error(data.message || 'Unknown error'); }
        } catch (error) {
            showToast('Error submitting new report: ' + error.message, true); // DEBUG
            const failedIndex = allReports.findIndex(r => r.timestamp === optimisticReport.timestamp);
            if (failedIndex > -1) allReports.splice(failedIndex, 1);
            updateDashboard();
        } finally {
            resetReportForm();
        }
    }

    async function submitIncrementRequest(lat, lng, existingReportData) {
        const formData = new FormData();
        formData.append('action', 'incrementVerifiedCount');
        formData.append('lat', parseFloat(lat));
        formData.append('lng', parseFloat(lng));

        try {
            const response = await fetch(SCRIPT_URL, { method: 'POST', body: formData });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            if (data.result === 'success') {
                if (existingReportData) {
                    existingReportData.verifiedcount = data.newCount;
                    existingReportData.certify = (data.newCount >= 2) ? "Verified by users" : "";
                }
                updateDashboard();
                showToast("Your record has been sent. Thank you!");
            } else {
                throw new Error(data.message || 'Unknown error while incrementing count');
            }
        } catch (error) {
            showToast('Error updating verification count: ' + error.message, true);
        } finally {
            map.closePopup();
        }
    }

    function resetReportForm() {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit';
        repForm.reset();
        repForm.classList.remove('was-validated');
        reportModal.hide();
        dsdNameInput.value = '';
        responsibleOfficeNameInput.value = '';
        responsibleOfficePhoneInput.value = '';
        riskLevelInput.value = '';
        proximityListUl.innerHTML = '';
        proximityAlertsDiv.style.display = 'none';
        liveLocationWarning.style.display = 'block';
    }


    // --- App Initialization ---
    async function initializeApp() {
        // Create the custom Leaflet control for the locate button
        const LocateControl = L.Control.extend({
            onAdd: function(map) {
                const container = L.DomUtil.create('div', 'leaflet-bar'); // Standard Leaflet control styling
                const button = L.DomUtil.create('a', 'leaflet-control-button btn btn-light btn-sm', container);
                button.href = '#';
                button.role = 'button';
                button.title = 'Find My Location';
                button.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> My Live Location';

                // Prevent click events from propagating to the map
                L.DomEvent.disableClickPropagation(container); // Disable on the container
                L.DomEvent.disableScrollPropagation(container); // Disable scroll on the container

                // Attach the click handler to the button
                L.DomEvent.on(button, 'click', L.DomEvent.stop) // Stop event propagation for the button itself
                          .on(button, 'click', () => { // Attach your custom logic
                              showToast("Getting your location... Please allow access.");
                              navigator.geolocation.getCurrentPosition(
                                  (position) => {
                                      const { latitude, longitude } = position.coords;
                                      map.setView([latitude, longitude], 16);
                                      L.circleMarker([latitude, longitude], { radius: 8, color: '#0ea5e9', fillColor: '#0ea5e9', fillOpacity: 0.8 }).addTo(map)
                                          .bindPopup("Your Current Location").openPopup();
                                  },
                                  (error) => {
                                      console.error("Geolocation error:", error);
                                      showToast("Could not get your location. Please enable location services.", true);
                                  }
                              );
                          });

                return container;
            },
            onRemove: function(map) {
                // Nothing to do here
            }
        });

        // Add the custom control to the map
        map.addControl(new LocateControl({ position: 'bottomleft' }));


        const fetchGeoJSON = async (url, style = null, pointToLayer = null) => {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Failed to load: ${url}. Status: ${response.status}`);
                const geojsonData = await response.json();
                console.log(`Successfully fetched JSON from ${url}`); // DEBUG
                
                const leafletLayer = L.geoJSON(geojsonData, { style: style, pointToLayer: pointToLayer });
                console.log(`L.geoJSON for ${url} result:`, leafletLayer); // DEBUG
                
                if (leafletLayer.getLayers().length === 0 && geojsonData.features && geojsonData.features.length > 0) {
                     console.warn(`Leaflet.geoJSON created an empty layer for ${url} despite having features. Possible GeoJSON structure issue.`, geojsonData); // DEBUG
                }
                return leafletLayer;
            } catch (error) {
                console.error(`Error loading GeoJSON from ${url}:`, error); // DEBUG
                showToast(`Error: Could not load map data from ${url}. Please check filename and path.`, true);
                return null;
            }
        };

        const [
            boundaryData, 
            dsdData, 
            hospitalData, 
            touristData, 
            lakeData, 
            riverData, 
            schoolData, 
            primarySchoolData,
            officeData
        ] = await Promise.all([
            fetchGeoJSON('nwp_boundary.geojson', { color: "#1e40af", weight: 3, opacity: 0.7, fill: false, interactive: false }),
            fetchGeoJSON('DSD_N.geojson', { color: "#64748b", weight: 1, opacity: 0.5, fillOpacity: 0.1, interactive: false }),
            fetchGeoJSON('government_hospitals.geojson', null, (f,l) => L.marker(l, { icon: L.divIcon({ className: 'custom-icon hospital-icon', html: '<i class="fa-solid fa-kit-medical"></i>' }) })),
            fetchGeoJSON('tourist_spots.geojson', null, (f,l) => L.marker(l, { icon: L.divIcon({ className: 'custom-icon tourist-icon', html: '<i class="fa-solid fa-star"></i>' }) })),
            fetchGeoJSON('Lake.geojson', { color: "#6ED2DD", weight: 2, fillOpacity: 0.6 }),
            fetchGeoJSON('River.geojson', { color: "#6ED2DD", weight: 2 }),
            fetchGeoJSON('schools.geojson', null, (f,l) => L.marker(l, { icon: L.divIcon({ className: 'custom-icon school-icon', html: '<i class="fa-solid fa-school"></i>' }) })),
            fetchGeoJSON('Primary_Schools.geojson', null, (f,l) => L.marker(l, { icon: L.divIcon({ className: 'custom-icon primary-school-icon', html: '<i class="fa-solid fa-school-flag"></i>' }) })),
            fetchGeoJSON('Office.geojson', null, (f,l) => L.marker(l, { icon: L.divIcon({ className: 'custom-icon office-icon', html: '<i class="fa-solid fa-building"></i>' }) }))
        ]);

        if (boundaryData) {
            provinceLayer = boundaryData;
            provinceLayer.addTo(map);
            console.log("Province boundary layer added to map."); // DEBUG
            if (!(new URLSearchParams(window.location.search).has('lat'))) {
                map.fitBounds(provinceLayer.getBounds());
            }
        } else {
            console.warn("nwp_boundary.geojson was not loaded. Point-in-province check will fail."); // DEBUG
        }
        
        if (dsdData) {
            dsdLayer = dsdData;
            dsdLayer.addTo(map);
            console.log("DSD boundary layer added to map."); // DEBUG
        } else {
            console.warn("DSD_N.geojson was not loaded. Authority detection will fail."); // DEBUG
        }

        if (primarySchoolData) {
            geojsonLayers.primarySchools = primarySchoolData;
            console.log("Primary Schools GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (hospitalData) {
            geojsonLayers.hospitals = hospitalData;
            console.log("Hospitals GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (schoolData) {
            geojsonLayers.schools = schoolData;
            console.log("Schools GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (touristData) {
            geojsonLayers.touristSpots = touristData;
            console.log("Tourist Spots GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (lakeData) {
            geojsonLayers.lakes = lakeData;
            console.log("Lakes GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (riverData) {
            geojsonLayers.rivers = riverData;
            console.log("Rivers GeoJSON assigned for risk calculation."); // DEBUG
        }
        if (officeData) {
            geojsonLayers.office = officeData;
            console.log("Office GeoJSON assigned for proximity lookup."); // DEBUG
        }
        
        sensitiveLayersReady = true; 
        console.log("All sensitive layers processed. sensitiveLayersReady is now TRUE."); // DEBUG

        const overlayMaps = {};
        if (hospitalData) overlayMaps['<i class="fa-solid fa-kit-medical legend-icon hospital-icon"></i> Hospitals'] = hospitalData;
        if (touristData) overlayMaps['<i class="fa-solid fa-star legend-icon tourist-icon"></i> Tourist Spots'] = touristData;
        if (lakeData) overlayMaps['<i class="fa-solid fa-water legend-icon lake-icon"></i> Lakes'] = lakeData;
        if (riverData) overlayMaps['<i class="fa-solid fa-water-ladder legend-icon river-icon"></i> Rivers'] = riverData;
        if (schoolData) overlayMaps['<i class="fa-solid fa-school legend-icon school-icon"></i> Schools'] = schoolData;
        if (primarySchoolData) overlayMaps['<i class="fa-solid fa-school-flag legend-icon primary-school-icon"></i> Primary Schools'] = primarySchoolData;
        if (officeData) overlayMaps['<i class="fa-solid fa-building legend-icon office-icon"></i> Government Offices'] = officeData;
        
        L.control.layers(null, overlayMaps, { collapsed: false }).addTo(map);

        try {
            const response = await fetch(SCRIPT_URL);
            if (!response.ok) throw new Error(`Network error. Status: ${response.status}`);
            const contentType = response.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                throw new Error(`Received non-JSON response from script. Check SCRIPT_URL. Content-Type: ${contentType}`);
            }
            const res = await response.json();
            if (res.result === 'success') {
                res.data.forEach(report => {
                    if (report.latitude && report.longitude) {
                        allReports.push({
                            ...report,
                            lat: parseFloat(report.latitude),
                            lng: parseFloat(report.longitude),
                            time: new Date(report.timestamp).getTime(),
                            wtype: report.wtype,
                            wsize: report.wsize,
                            description: report.description,
                            photourl: report.photourl,
                            status: report.status,
                            authority: report.authority, // Keep this for now for backwards compatibility if needed
                            dsdname: report.dsdname,
                            responsibleoffice: report.responsibleoffice,
                            responsibleofficephone: report.responsibleofficephone,
                            risklevel: report.risklevel || "Low",
                            verifiedcount: parseInt(report.verifiedcount || 1),
                            certify: ''
                        });
                    }
                });
                updateDashboard();
                console.log("Existing reports loaded and dashboard updated."); // DEBUG
            } else { throw new Error(res.message); }
        } catch (error) { 
            console.error("Fetch Error during initialization:", error); // DEBUG
            showToast('Failed to load existing reports: ' + error.message + ". Please ensure Google Sheet headers are correct and script is deployed.", true);
        }
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('lat') && urlParams.has('lng')) {
        map.setView([parseFloat(urlParams.get('lat')), parseFloat(urlParams.get('lng'))], parseInt(urlParams.get('zoom')) || 14);
    }
    initializeApp();
});