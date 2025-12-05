import pandas as pd

file_path = '/Users/leuyentran/Downloads/Dataset on irrigation for Tomato/tomato irrigation dataset.csv' 
df = pd.read_csv(file_path)

# Strip whitespace from column names
df.columns = df.columns.str.strip() 
print("Các cột sau khi xử lý:", df.columns.tolist()) 

# choose columm 
selected_columns = ['Temperature [_ C]', 'Humidity [%]', 'Soil moisture']
df_clean = df[selected_columns].copy()

# rename
df_clean.columns = ['temp', 'hum', 'soil']

# Labeling
def generate_label(row):
    if row['soil'] < 350: 
        return 1
    elif row['temp'] > 30 and row['soil'] < 450:
        return 1
    elif row['hum'] < 50 and row['soil'] < 550:
        return 1
    else:
        return 0

df_clean['Pump_Action'] = df_clean.apply(generate_label, axis=1)

output_path = '/Users/leuyentran/Documents/training/dataset_chuan.csv'
df_clean.to_csv(output_path, index=False)

print(f"Finish, save: {output_path}")
print(df_clean.head())
