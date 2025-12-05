import sys
import joblib
import pandas as pd
import json
import os

# Get the directory where this script is located
script_dir = os.path.dirname(os.path.abspath(__file__))
model_path = os.path.join(script_dir, 'model_tuoi_cay.pkl')

# 1. Load model 
try:
    model = joblib.load(model_path)
except Exception as e:
    print(json.dumps({"action": 0, "error": f"No model found: {str(e)}"}))
    sys.exit(0)


try:
    temp = float(sys.argv[1])
    humid = float(sys.argv[2])
    soil = float(sys.argv[3])

    input_data = pd.DataFrame([[temp, humid, soil]], 
                              columns=['temp', 'hum', 'soil'])

    # 3. Dự đoán
    prediction = model.predict(input_data)
    
    # 4. Trả kết quả về cho Node.js (dạng JSON)
    result = {
        "action": int(prediction[0]), 
        "reason": "AI Model Decision"
    }
    print(json.dumps(result)) 

except Exception as e:
    print(json.dumps({"action": 0, "error": str(e)}))
