import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
import joblib
import os


dataset_path = 'dataset_chuan.csv' 

if not os.path.exists(dataset_path):
    print(f" error: cannot find data {dataset_path}")
    exit()

data = pd.read_csv(dataset_path)

feature_cols = ['temp', 'hum', 'soil'] 
X = data[feature_cols]
y = data['Pump_Action']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

# Train model RANDOM FOREST
print("training Random Forest...")
clf = RandomForestClassifier(n_estimators=100, max_depth=10, random_state=42)
clf.fit(X_train, y_train)

# check model
y_pred = clf.predict(X_test)
acc = accuracy_score(y_test, y_pred)
print(f"accuracy: {acc * 100:.2f}%")
print("\n--- report ---")
print(classification_report(y_test, y_pred))

# save model 
output_model_path = 'model_tuoi_cay.pkl'
joblib.dump(clf, output_model_path)
print(f"save new model: {output_model_path}")

# Test 
test_sample = pd.DataFrame([[35, 40, 400]], columns=feature_cols)
prediction = clf.predict(test_sample)[0]
print(f" Test(temp=35, hum=40, soil=400): {'Pump' if prediction==1 else 'Not Pump'}")
